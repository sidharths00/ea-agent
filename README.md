# EA Agent — AI Scheduling Assistant

An AI executive assistant that lives in your email. CC it on any thread and it will propose meeting times, wait for confirmation, and book the calendar event — all autonomously.

Built with Claude (Anthropic), AgentMail, and Google Calendar.

---

## How it works

```
Incoming email
     │
     ▼
POST /webhook/email  (Express server)
     │   Acknowledge immediately; run agent async
     ▼
Claude agentic loop  (src/agent.ts)
     │   Reads thread context, calls tools until done
     ├── get_preferences     → SQLite key-value store
     ├── get_availability    → Google Calendar freebusy API
     ├── send_email          → AgentMail reply in-thread
     ├── update_thread_state → SQLite state machine
     └── book_meeting        → Google Calendar event + confirmation email
```

**State machine:** `new → awaiting_confirmation → booked | cancelled`

Each email thread is tracked in SQLite. When someone confirms a slot, the agent books the event and updates the existing calendar event if rescheduling (no delete/recreate).

---

## Prerequisites

- [Anthropic account](https://console.anthropic.com) — for Claude API access
- [AgentMail account](https://agentmail.to) — for the agent email inbox and webhook delivery
- [Google Cloud project](https://console.cloud.google.com) with the Calendar API enabled — for reading/writing calendar events
- Node.js 18+

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/yourusername/ea-agent.git
cd ea-agent
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in the values as you complete the steps below. See `.env.example` for descriptions of each variable.

### 3. Get your Anthropic API key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. Add to `.env`: `ANTHROPIC_API_KEY=sk-ant-...`

### 4. Set up AgentMail

1. Sign up at [agentmail.to](https://agentmail.to) and get your API key
2. Add to `.env`: `AGENTMAIL_API_KEY=...`
3. Create your agent inbox:

```bash
npm run create:inbox
```

This prints your `AGENTMAIL_INBOX_ID` — copy it to `.env`.

> **Custom domain**: If you're on an AgentMail paid plan, edit `scripts/create-inbox.ts` to pass your domain, then update `AGENT_EMAIL` in `.env` accordingly.

### 5. Set up Google Calendar

1. In [Google Cloud Console](https://console.cloud.google.com):
   - Create a new project (or use an existing one)
   - Enable the **Google Calendar API**
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Add `http://localhost:3001/oauth/callback` to **Authorized redirect URIs**
   - Download the credentials

2. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3001/oauth/callback
   ```

3. Run the OAuth setup script:

```bash
npm run setup:google
```

This opens a browser, asks you to authorize, then prints your `GOOGLE_REFRESH_TOKEN`. Copy it to `.env`.

4. Set `GOOGLE_CALENDAR_ID=primary` (or use a specific calendar's email address).

### 6. Configure agent identity

In `.env`:

```env
OWNER_NAME=Your Name
OWNER_TIMEZONE=America/New_York   # IANA timezone
AGENT_EMAIL=ea@agentmail.to       # The inbox you created above
WEBHOOK_SECRET=some-random-secret # Optional but recommended
```

### 7. Seed scheduling preferences

```bash
npm run seed:prefs
```

This runs an interactive CLI to set your working hours, meeting duration, buffer times, video platform preference, and no-meeting days. You can update individual preferences at any time by running it again or by emailing the agent directly ("set my default meeting duration to 45 minutes").

### 8. Deploy to Railway

Railway is the recommended way to run EA Agent — it gives you a stable HTTPS URL, persistent uptime, and no need for ngrok or a local server.

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

Then in the [Railway dashboard](https://railway.app):
1. Go to your project → **Variables** and add all the env vars from your `.env` file
2. Copy your service's public URL (e.g. `https://ea-agent-production.up.railway.app`)

### 9. Register the webhook with AgentMail

In the [AgentMail dashboard](https://agentmail.to), set your inbox's webhook URL to:

```
https://your-railway-url.up.railway.app/webhook/email
```

If you set `WEBHOOK_SECRET` in `.env`, configure the same secret in AgentMail's webhook settings.

That's it — the agent is live. No `npm run dev`, no ngrok.

---

## Usage

CC your agent email on any email thread where you want to schedule a meeting:

```
To: external.person@company.com
CC: ea@agentmail.to
Subject: Intro call?
```

The agent will:
1. Read the thread to understand who to schedule with and what for
2. Check your calendar for open slots
3. Reply with 3–5 concrete time options
4. Wait for confirmation
5. Book the calendar event and send a confirmation to all parties

You can also email the agent directly to ask about your availability or update its behavior:

```
To: ea@agentmail.to
Subject: What's my schedule look like next week?
```

```
To: ea@agentmail.to
Subject: Preferences
Body: Remember that "dinner" means 6pm PT.
```

---

## Customization

All scheduling behavior is controlled by preferences stored in SQLite. You can change them by:

- Running `npm run seed:prefs`
- Emailing the agent directly: *"Set my working hours to 8am–5pm"*

Available preferences:

| Key | Description | Default |
|-----|-------------|---------|
| `workingHoursStart` | Start of workday (HH:MM, 24h) | `09:00` |
| `workingHoursEnd` | End of workday (HH:MM, 24h) | `18:00` |
| `timezone` | IANA timezone | from `OWNER_TIMEZONE` env var |
| `defaultMeetingDurationMinutes` | Default meeting length | `30` |
| `bufferBeforeMinutes` | Buffer before each meeting | `5` |
| `bufferAfterMinutes` | Buffer after each meeting | `5` |
| `preferredPlatform` | Video platform (`Google Meet`, `Zoom`, etc.) | `Google Meet` |
| `maxMeetingsPerDay` | Max meetings allowed per day | `6` |
| `noMeetingDays` | Days to block (JSON array, 0=Sun, 6=Sat) | `[0, 6]` |
| `customRules` | Freeform instructions the agent always follows | `""` |

---

## Architecture

```
src/
├── index.ts          Express webhook server + /health endpoint
├── agent.ts          Claude agentic loop, tool definitions, system prompt
├── types.ts          TypeScript interfaces (IncomingEmail, Thread, Preferences, ...)
├── db/
│   └── index.ts      SQLite schema (WAL mode), CRUD for threads + preferences
└── tools/
    ├── calendar.ts   Google Calendar freebusy + create/update event
    ├── email.ts      AgentMail send (in-thread, HTML blockquote quoting)
    ├── preferences.ts Read/write scheduling preferences
    └── threads.ts    Thread state machine updates

scripts/
├── create-inbox.ts       One-time: create AgentMail inbox
├── setup-google-auth.ts  One-time: OAuth2 → GOOGLE_REFRESH_TOKEN
└── seed-preferences.ts   Interactive preference configuration
```

**Key design decisions:**

- **Fire-and-forget webhook**: the server acknowledges AgentMail immediately (HTTP 200) and runs the agent asynchronously — no timeout risk
- **Agentic loop**: Claude decides which tools to call and when; no rigid state machine in the orchestrator
- **Rescheduling**: the agent stores the Google Calendar event ID in SQLite and updates (not deletes+creates) the event when rescheduling, preserving invites
- **Thread-aware routing**: if an external party is in the thread, the agent replies to them and CCs the owner; if the owner emailed directly, it replies to the owner only
- **All calendars**: availability check queries all Google Calendars the account can see (not just primary), so nothing gets double-booked

---

## Other deployment options

Railway is recommended, but any Node.js host works. Avoid free tiers that sleep on inactivity (e.g. Render free) — a sleeping server will miss webhooks.

**Render** (paid tier)
- Create a new Web Service → build: `npm run build`, start: `npm start`
- Add env vars in the Render dashboard

**Fly.io**
```bash
fly launch
fly secrets set ANTHROPIC_API_KEY=... AGENTMAIL_API_KEY=... # etc.
fly deploy
```

---

## Local development

If you want to run locally for testing:

```bash
npm run dev        # starts server on port 3000
ngrok http 3000    # exposes it publicly
```

Use the ngrok URL as your temporary AgentMail webhook URL.

---

## Available scripts

```bash
npm run dev          # Start with hot reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled output
npm run create:inbox # One-time: create AgentMail inbox
npm run setup:google # One-time: Google OAuth2 → refresh token
npm run seed:prefs   # Interactive scheduling preferences setup
```

---

## License

MIT — see [LICENSE](LICENSE).
