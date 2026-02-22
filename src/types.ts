// ── Email ──────────────────────────────────────────────────────────────────────

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface IncomingEmail {
  messageId: string;
  threadId: string;
  inboxId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  timestamp: string;
}

// ── Thread state ───────────────────────────────────────────────────────────────

export type ThreadState =
  | "new"
  | "awaiting_confirmation"
  | "booked"
  | "cancelled";

export interface Thread {
  id: number;
  threadId: string;
  state: ThreadState;
  proposedSlots: TimeSlot[] | null;
  requesterEmail: string;
  requesterName: string | null;
  meetingTitle: string | null;
  meetingDurationMinutes: number | null;
  calendarEventId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimeSlot {
  start: string; // ISO 8601
  end: string;   // ISO 8601
}

// ── Preferences ────────────────────────────────────────────────────────────────

export interface Preferences {
  workingHoursStart: string;    // "HH:MM" in owner timezone
  workingHoursEnd: string;      // "HH:MM" in owner timezone
  timezone: string;             // IANA timezone string
  defaultMeetingDurationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  preferredPlatform: string;    // "Google Meet" | "Zoom" | "phone" etc.
  maxMeetingsPerDay: number;
  noMeetingDays: number[];      // 0=Sun, 1=Mon, ... 6=Sat
}

// ── Agent ──────────────────────────────────────────────────────────────────────

export interface AgentContext {
  email: IncomingEmail;
  thread: Thread | null;
  conversationHistory: string;
}
