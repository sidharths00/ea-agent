import "dotenv/config";
import express from "express";
import { getThread, upsertThread } from "./db/index.js";
import { runAgent } from "./agent.js";
import type { IncomingEmail } from "./types.js";

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ── Webhook auth middleware ────────────────────────────────────────────────────

function verifyWebhookSecret(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!WEBHOOK_SECRET) {
    next();
    return;
  }
  const secret =
    req.headers["x-webhook-secret"] ?? req.query["secret"];
  if (secret !== WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// ── AgentMail webhook ─────────────────────────────────────────────────────────

app.post("/webhook/email", verifyWebhookSecret, async (req, res) => {
  try {
    const payload = req.body;
    console.log("[webhook] Received payload:", JSON.stringify(payload, null, 2));

    // AgentMail (via Svix) sends { event_type: "message.received", message: { ... }, thread: { ... } }
    const eventType = payload.event_type ?? payload.event;
    if (eventType !== "message.received") {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    const data = payload.message ?? payload.data ?? payload;

    const email: IncomingEmail = {
      messageId: data.message_id ?? data.messageId ?? data.id,
      threadId: data.thread_id ?? data.threadId ?? data.message_id ?? data.id,
      inboxId: data.inbox_id ?? data.inboxId,
      from: normalizeAddress(data.from_ ?? data.from),
      to: Array.isArray(data.to) ? data.to.map(normalizeAddress) : [normalizeAddress(data.to)],
      cc: data.cc ? (Array.isArray(data.cc) ? data.cc.map(normalizeAddress) : [normalizeAddress(data.cc)]) : [],
      subject: data.subject ?? "(no subject)",
      text: data.text ?? data.extracted_text ?? data.body,
      html: data.html ?? data.extracted_html,
      timestamp: data.timestamp ?? data.created_at ?? data.createdAt ?? new Date().toISOString(),
    };

    // Skip emails sent by the agent itself to avoid loops
    const agentEmail = process.env.AGENT_EMAIL ?? "ea@agentmail.to";
    if (email.from.email.toLowerCase().includes(agentEmail.toLowerCase())) {
      console.log("[webhook] Skipping self-sent email");
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    // Look up or bootstrap thread state
    let thread = getThread(email.threadId);
    if (!thread) {
      thread = upsertThread({
        threadId: email.threadId,
        state: "new",
        requesterEmail: email.from.email,
        requesterName: email.from.name ?? null,
      });
    }

    // Acknowledge immediately — agent runs async
    res.status(200).json({ ok: true });

    // Run the agent (don't await in the response path)
    runAgent({ email, thread, conversationHistory: "" }).catch((err) => {
      console.error("[agent] Unhandled error:", err);
    });
  } catch (err) {
    console.error("[webhook] Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Health check ───────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`EA Agent running on http://localhost:${PORT}`);
  console.log(`Webhook endpoint: POST http://localhost:${PORT}/webhook/email`);
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function normalizeAddress(addr: unknown): { email: string; name?: string } {
  if (typeof addr === "string") {
    // "Name <email>" format
    const match = addr.match(/^(.+?)\s*<(.+?)>$/);
    if (match) return { name: match[1].trim(), email: match[2].trim() };
    return { email: addr.trim() };
  }
  if (typeof addr === "object" && addr !== null) {
    const a = addr as Record<string, string>;
    return { email: a.email ?? a.address, name: a.name };
  }
  return { email: String(addr) };
}
