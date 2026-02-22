import Anthropic from "@anthropic-ai/sdk";
import type {
  Tool,
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages.js";
import { AgentMailClient } from "agentmail";
import { toolGetPreferences, toolSetPreference } from "./tools/preferences.js";
import { toolGetThread, toolUpdateThreadState } from "./tools/threads.js";
import { toolGetAvailability, toolCreateCalendarEvent, toolUpdateCalendarEvent, toolListEvents, toolCancelCalendarEvent, type BookingResult } from "./tools/calendar.js";
import { toolSendEmail } from "./tools/email.js";
import type { AgentContext } from "./types.js";

const client = new Anthropic();

// ── Tool definitions ───────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "get_preferences",
    description:
      "Retrieve the owner's scheduling preferences: working hours, timezone, buffer time, default meeting duration, preferred video platform, max meetings per day, and no-meeting days.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "set_preference",
    description: "Update a single scheduling preference value.",
    input_schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Preference key. One of: workingHoursStart, workingHoursEnd, timezone, defaultMeetingDurationMinutes, bufferBeforeMinutes, bufferAfterMinutes, preferredPlatform, maxMeetingsPerDay, noMeetingDays, customRules. Use customRules to store freeform owner instructions (e.g. 'dinner means 6pm PT'). When appending to customRules, read existing value first and include all prior rules plus the new one.",
        },
        value: { type: "string", description: "New value for the preference." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "get_availability",
    description:
      "Query the owner's Google Calendar for free time within a date range. Returns contiguous free windows (e.g. '10:05 AM – 2:55 PM') that satisfy working hours, buffer requirements, and existing events. Pick specific times within these windows when proposing slots.",
    input_schema: {
      type: "object",
      properties: {
        startDate: {
          type: "string",
          description: "Start of the search window, in YYYY-MM-DD format.",
        },
        endDate: {
          type: "string",
          description: "End of the search window (inclusive), in YYYY-MM-DD format.",
        },
        durationMinutes: {
          type: "number",
          description:
            "Desired meeting duration in minutes. Defaults to the owner's defaultMeetingDurationMinutes preference.",
        },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email reply in the current thread. Use this to propose times, ask clarifying questions, or confirm a booking.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Email subject line." },
        body: {
          type: "string",
          description:
            "Plain-text email body. Be concise and professional. When proposing slots, list them clearly with day, date, and time (including timezone).",
        },
      },
      required: ["subject", "body"],
    },
  },
  {
    name: "update_thread_state",
    description:
      "Update the scheduling thread's state in the database. Call this after sending proposed times (set state to 'awaiting_confirmation') or after booking (set state to 'booked').",
    input_schema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["new", "awaiting_confirmation", "booked", "cancelled"],
          description: "New state for the thread.",
        },
        proposedSlots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "string", description: "ISO 8601 start time." },
              end: { type: "string", description: "ISO 8601 end time." },
            },
            required: ["start", "end"],
          },
          description: "The slots that were proposed to the requester.",
        },
        meetingTitle: {
          type: "string",
          description: "Title/purpose of the meeting if known.",
        },
        meetingDurationMinutes: {
          type: "number",
          description: "Duration of the meeting in minutes.",
        },
      },
      required: ["state"],
    },
  },
  {
    name: "book_meeting",
    description:
      "Create or update a Google Calendar event and send a booking confirmation email. Call this once the requester has confirmed a specific time slot. When rescheduling, pass existingEventId (obtained from list_events) to update the existing event in place rather than creating a duplicate.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title." },
        start: {
          type: "string",
          description: "ISO 8601 start time of the confirmed slot.",
        },
        end: {
          type: "string",
          description: "ISO 8601 end time of the confirmed slot.",
        },
        attendeeEmail: {
          type: "string",
          description: "Email address of the person who requested the meeting.",
        },
        attendeeName: {
          type: "string",
          description: "Name of the person who requested the meeting.",
        },
        description: {
          type: "string",
          description: "Optional agenda or meeting notes to include in the invite.",
        },
        existingEventId: {
          type: "string",
          description: "Google Calendar event ID of the meeting to reschedule. Obtain this by calling list_events first. When provided, the existing event is updated instead of a new one being created.",
        },
      },
      required: ["title", "start", "end", "attendeeEmail"],
    },
  },
  {
    name: "list_events",
    description:
      "List Google Calendar events within a date range. Use this to identify which specific event to reschedule or cancel — always call this first before book_meeting (when rescheduling) or cancel_meeting, so you have the correct event ID.",
    input_schema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start of range, YYYY-MM-DD." },
        endDate: { type: "string", description: "End of range (inclusive), YYYY-MM-DD." },
      },
      required: ["startDate", "endDate"],
    },
  },
  {
    name: "cancel_meeting",
    description:
      "Cancel a Google Calendar event and notify all attendees. Always call list_events first to get the correct event ID — never guess it.",
    input_schema: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Google Calendar event ID to cancel. Obtain from list_events." },
      },
      required: ["eventId"],
    },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ctx: AgentContext
): Promise<unknown> {
  const prefs = toolGetPreferences();

  switch (toolName) {
    case "get_preferences":
      return prefs;

    case "set_preference":
      return toolSetPreference(
        toolInput.key as string,
        toolInput.value as string
      );

    case "get_availability": {
      const duration =
        (toolInput.durationMinutes as number | undefined) ??
        prefs.defaultMeetingDurationMinutes;
      return toolGetAvailability(
        toolInput.startDate as string,
        toolInput.endDate as string,
        prefs,
        duration
      );
    }

    case "send_email": {
      const agentEmail = (process.env.AGENT_EMAIL ?? "").toLowerCase();
      const ownerEmail = ctx.email.from.email;

      // All addresses in the thread except the agent itself
      const allParticipants = [
        ...ctx.email.to,
        ...(ctx.email.cc ?? []),
      ].filter((a) => a.email.toLowerCase() !== agentEmail);

      // External parties = participants who are not the owner
      const external = allParticipants.filter(
        (a) => a.email.toLowerCase() !== ownerEmail.toLowerCase()
      );

      // If there are external parties, send to them and CC the owner.
      // Otherwise (owner emailing agent directly), just reply to the owner.
      const toAddresses = external.length > 0 ? external : [ctx.email.from];
      const ccAddresses = external.length > 0 ? [ctx.email.from] : [];

      return toolSendEmail({
        to: toAddresses.map((a) => a.name ? `${a.name} <${a.email}>` : a.email),
        cc: ccAddresses.map((a) => a.name ? `${a.name} <${a.email}>` : a.email),
        subject: toolInput.subject as string,
        body: toolInput.body as string,
        inReplyToMessageId: ctx.email.messageId,
        quotedHtml: ctx.email.html,
        quotedText: ctx.email.text,
        quotedFrom: ctx.email.from.name
          ? `${ctx.email.from.name} <${ctx.email.from.email}>`
          : ctx.email.from.email,
        quotedDate: ctx.email.timestamp,
      });
    }

    case "update_thread_state":
      return toolUpdateThreadState({
        threadId: ctx.email.threadId,
        state: toolInput.state as any,
        proposedSlots: toolInput.proposedSlots as any,
        meetingTitle: toolInput.meetingTitle as string | undefined,
        meetingDurationMinutes: toolInput.meetingDurationMinutes as number | undefined,
      });

    case "book_meeting": {
      const prefs = toolGetPreferences();
      const addMeet = prefs.preferredPlatform === "Google Meet";

      // Prefer the event ID Claude explicitly found via list_events, then fall back
      // to whatever is stored on this thread in SQLite.
      const existingThread = toolGetThread(ctx.email.threadId);
      const existingEventId =
        (toolInput.existingEventId as string | undefined) ??
        existingThread?.calendarEventId;

      let booking: BookingResult;
      if (existingEventId) {
        try {
          await toolUpdateCalendarEvent(existingEventId, {
            title: toolInput.title as string,
            start: toolInput.start as string,
            end: toolInput.end as string,
            description: toolInput.description as string | undefined,
          });
          console.log(`[agent] Updated calendar event: ${existingEventId}`);
          booking = { eventId: existingEventId, eventLink: "", meetLink: undefined };
        } catch (err) {
          console.warn(`[agent] Could not update event, creating new one:`, err);
          booking = await toolCreateCalendarEvent({
            title: toolInput.title as string,
            start: toolInput.start as string,
            end: toolInput.end as string,
            attendeeEmail: toolInput.attendeeEmail as string,
            attendeeName: toolInput.attendeeName as string | undefined,
            description: toolInput.description as string | undefined,
            addGoogleMeet: addMeet,
          });
        }
      } else {
        booking = await toolCreateCalendarEvent({
          title: toolInput.title as string,
          start: toolInput.start as string,
          end: toolInput.end as string,
          attendeeEmail: toolInput.attendeeEmail as string,
          attendeeName: toolInput.attendeeName as string | undefined,
          description: toolInput.description as string | undefined,
          addGoogleMeet: addMeet,
        });
      }

      // Mark thread as booked and store the event ID + attendee for future reschedule lookups
      toolUpdateThreadState({
        threadId: ctx.email.threadId,
        state: "booked",
        calendarEventId: booking.eventId,
        attendeeEmail: toolInput.attendeeEmail as string,
      });

      return booking;
    }

    case "list_events":
      return toolListEvents(
        toolInput.startDate as string,
        toolInput.endDate as string
      );

    case "cancel_meeting":
      return toolCancelCalendarEvent(toolInput.eventId as string);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// ── System prompt ──────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `You are an AI executive assistant named EA, scheduling meetings on behalf of ${process.env.OWNER_NAME ?? "your owner"}.
Your email address is ${process.env.AGENT_EMAIL ?? "ea@agentmail.to"}. You are CC'd or added to email threads when someone needs to schedule time.

Today is ${today}.

YOUR JOB:
1. Read the full email thread (From, To, CC, body, prior messages) to understand who wants to meet, for how long, and what about.
   - The person to schedule with is whoever is in the To/CC field that is NOT the owner (${process.env.OWNER_NAME ?? "your owner"}) and NOT your own address.
   - If the owner CC'd you on a thread, the other participant(s) in To/CC are who you're scheduling with — do not ask for their email, it's already there.
2. Use get_preferences to fetch scheduling rules.
3. Use get_availability to find open slots over the next 5–10 business days (or the range implied by the request).
4. Use send_email to reply with 3–5 concrete time options. Always include day, date, time, and timezone.
5. Use update_thread_state to record the proposed slots and set state to "awaiting_confirmation".
6. If the incoming email IS a confirmation of a previously proposed slot, use book_meeting to create the calendar event, then send a confirmation email.
7. Only ask a clarifying question if the information is truly missing and cannot be inferred from the thread.

TONE: Professional, warm, and concise. Do not over-explain. Sign emails as "EA, on behalf of ${process.env.OWNER_NAME ?? "your owner"}".

IMPORTANT RULES:
- Always end every run by calling send_email. Never finish without sending a reply.
- Never propose slots outside working hours.
- Always respect buffer times when selecting from available slots.
- When replying, keep the subject line starting with "Re:" to stay in the thread.
- Only call book_meeting when the requester has explicitly confirmed a specific time.
- If the thread is already in state "booked", send a polite note that the meeting is already scheduled.
- If the owner emails asking about their own availability, reply with a clear summary of their free slots for the requested period.
- When rescheduling: call list_events over the date range of the old meeting to find the correct event ID, then pass it as existingEventId to book_meeting. Never guess an event ID.
- When cancelling a meeting: call list_events to identify the correct event by date and attendee, then call cancel_meeting with that event ID. Confirm the cancellation via send_email.
- If the owner says "remember X" or "always do Y", call set_preference with key="customRules" to persist it. Read existing customRules first and write back all prior rules plus the new one (one rule per line). Then apply the rule immediately in this same response.
- Always read customRules from get_preferences at the start and follow any rules stored there.`;
}

// ── Main agent loop ────────────────────────────────────────────────────────────

export async function runAgent(ctx: AgentContext): Promise<void> {
  const thread = ctx.thread;

  // Fetch prior messages in this thread for context
  let threadHistory = "";
  try {
    const agentmail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
    const { messages: priorMsgs } = await agentmail.inboxes.messages.list(
      process.env.AGENTMAIL_INBOX_ID!,
      { threadId: ctx.email.threadId }
    ) as any;
    // Exclude the current message; oldest first
    const others = (priorMsgs ?? [])
      .filter((m: any) => m.messageId !== ctx.email.messageId)
      .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (others.length > 0) {
      threadHistory = "\n\nPrior messages in this thread (oldest first):\n" +
        others.map((m: any) =>
          `---\nFrom: ${m.from}\nTo: ${[m.to].flat().join(", ")}\n${m.cc ? `CC: ${[m.cc].flat().join(", ")}\n` : ""}${m.subject ? `Subject: ${m.subject}\n` : ""}Body: ${m.preview ?? "(no preview)"}`
        ).join("\n");
    }
  } catch (_) {
    // Non-fatal — proceed without thread history
  }

  // Build the initial user message from the email context
  const to = ctx.email.to?.map((t) => (t.name ? `${t.name} <${t.email}>` : t.email)).join(", ") ?? "";
  const cc = ctx.email.cc?.map((t) => (t.name ? `${t.name} <${t.email}>` : t.email)).join(", ") ?? "";
  const emailSummary = [
    `From: ${ctx.email.from.name ? `${ctx.email.from.name} <${ctx.email.from.email}>` : ctx.email.from.email}`,
    to && `To: ${to}`,
    cc && `CC: ${cc}`,
    `Subject: ${ctx.email.subject}`,
    `Thread state: ${thread?.state ?? "new"}`,
    thread?.proposedSlots
      ? `Previously proposed slots: ${JSON.stringify(thread.proposedSlots)}`
      : null,
    `\nEmail body:\n${ctx.email.text ?? ctx.email.html ?? "(no body)"}`,
    threadHistory,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: MessageParam[] = [
    { role: "user", content: emailSummary },
  ];

  // Agentic loop — keep going until Claude stops calling tools
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    // Add assistant response to history
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      // Claude is done — no more tool calls
      console.log("[agent] Done.");
      break;
    }

    if (response.stop_reason !== "tool_use") {
      console.warn("[agent] Unexpected stop_reason:", response.stop_reason);
      break;
    }

    // Execute all tool calls in this response
    const toolResults: ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      console.log(`[agent] Calling tool: ${block.name}`, block.input);

      let result: unknown;
      try {
        result = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          ctx
        );
      } catch (err) {
        result = { error: (err as Error).message };
        console.error(`[agent] Tool error (${block.name}):`, err);
      }

      console.log(`[agent] Tool result (${block.name}):`, result);

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
