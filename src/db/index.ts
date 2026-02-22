import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Thread, ThreadState, TimeSlot, Preferences } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../../data/ea-agent.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferences (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id                TEXT UNIQUE NOT NULL,
      state                    TEXT NOT NULL DEFAULT 'new',
      proposed_slots           TEXT,
      requester_email          TEXT NOT NULL,
      requester_name           TEXT,
      meeting_title            TEXT,
      meeting_duration_minutes INTEGER,
      calendar_event_id        TEXT,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Add calendar_event_id column to existing DBs that predate this field
  try { db.exec("ALTER TABLE threads ADD COLUMN calendar_event_id TEXT"); } catch {}
  // Add attendee_email column to existing DBs that predate this field
  try { db.exec("ALTER TABLE threads ADD COLUMN attendee_email TEXT"); } catch {}
  seedDefaultPreferences(db);
}

const DEFAULT_PREFERENCES: Record<string, string> = {
  workingHoursStart: "09:00",
  workingHoursEnd: "18:00",
  timezone: process.env.OWNER_TIMEZONE ?? "America/Los_Angeles",
  defaultMeetingDurationMinutes: "30",
  bufferBeforeMinutes: "5",
  bufferAfterMinutes: "5",
  preferredPlatform: "Google Meet",
  maxMeetingsPerDay: "6",
  noMeetingDays: JSON.stringify([0, 6]), // Sun, Sat
  customRules: "",
};

function seedDefaultPreferences(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
    insert.run(key, value);
  }
}

// ── Preferences ────────────────────────────────────────────────────────────────

export function getPreferences(): Preferences {
  const db = getDb();
  const rows = db
    .prepare("SELECT key, value FROM preferences")
    .all() as { key: string; value: string }[];

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    workingHoursStart: map.workingHoursStart ?? "09:00",
    workingHoursEnd: map.workingHoursEnd ?? "18:00",
    timezone: map.timezone ?? "America/Los_Angeles",
    defaultMeetingDurationMinutes: Number(map.defaultMeetingDurationMinutes ?? 30),
    bufferBeforeMinutes: Number(map.bufferBeforeMinutes ?? 5),
    bufferAfterMinutes: Number(map.bufferAfterMinutes ?? 5),
    preferredPlatform: map.preferredPlatform ?? "Google Meet",
    maxMeetingsPerDay: Number(map.maxMeetingsPerDay ?? 6),
    noMeetingDays: JSON.parse(map.noMeetingDays ?? "[0,6]"),
    customRules: map.customRules ?? "",
  };
}

export function setPreference(key: string, value: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)")
    .run(key, value);
}

// ── Threads ────────────────────────────────────────────────────────────────────

interface ThreadRow {
  id: number;
  thread_id: string;
  state: string;
  proposed_slots: string | null;
  requester_email: string;
  requester_name: string | null;
  attendee_email: string | null;
  meeting_title: string | null;
  meeting_duration_minutes: number | null;
  calendar_event_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    threadId: row.thread_id,
    state: row.state as ThreadState,
    proposedSlots: row.proposed_slots ? JSON.parse(row.proposed_slots) : null,
    requesterEmail: row.requester_email,
    requesterName: row.requester_name,
    attendeeEmail: row.attendee_email,
    meetingTitle: row.meeting_title,
    meetingDurationMinutes: row.meeting_duration_minutes,
    calendarEventId: row.calendar_event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getThread(threadId: string): Thread | null {
  const row = getDb()
    .prepare("SELECT * FROM threads WHERE thread_id = ?")
    .get(threadId) as ThreadRow | undefined;
  return row ? rowToThread(row) : null;
}

export function upsertThread(params: {
  threadId: string;
  state: ThreadState;
  requesterEmail?: string;
  requesterName?: string | null;
  attendeeEmail?: string | null;
  meetingTitle?: string | null;
  meetingDurationMinutes?: number | null;
  proposedSlots?: TimeSlot[] | null;
  calendarEventId?: string | null;
}): Thread {
  const db = getDb();
  db.prepare(`
    INSERT INTO threads (
      thread_id, state, requester_email, requester_name, attendee_email,
      meeting_title, meeting_duration_minutes, proposed_slots, calendar_event_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(thread_id) DO UPDATE SET
      state                    = excluded.state,
      requester_name           = COALESCE(excluded.requester_name, requester_name),
      attendee_email           = COALESCE(excluded.attendee_email, attendee_email),
      meeting_title            = COALESCE(excluded.meeting_title, meeting_title),
      meeting_duration_minutes = COALESCE(excluded.meeting_duration_minutes, meeting_duration_minutes),
      proposed_slots           = excluded.proposed_slots,
      calendar_event_id        = COALESCE(excluded.calendar_event_id, calendar_event_id),
      updated_at               = datetime('now')
  `).run(
    params.threadId,
    params.state,
    params.requesterEmail ?? "",
    params.requesterName ?? null,
    params.attendeeEmail ?? null,
    params.meetingTitle ?? null,
    params.meetingDurationMinutes ?? null,
    params.proposedSlots ? JSON.stringify(params.proposedSlots) : null,
    params.calendarEventId ?? null
  );

  return getThread(params.threadId)!;
}

export function findBookedByAttendee(attendeeEmail: string): Thread | null {
  const row = getDb()
    .prepare(`
      SELECT * FROM threads
      WHERE attendee_email = ? AND state = 'booked' AND calendar_event_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `)
    .get(attendeeEmail) as ThreadRow | undefined;
  return row ? rowToThread(row) : null;
}
