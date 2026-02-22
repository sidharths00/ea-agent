import { getThread, upsertThread } from "../db/index.js";
import type { Thread, ThreadState, TimeSlot } from "../types.js";

export function toolGetThread(threadId: string): Thread | null {
  return getThread(threadId);
}

export function toolUpdateThreadState(params: {
  threadId: string;
  state: ThreadState;
  proposedSlots?: TimeSlot[];
  meetingTitle?: string;
  meetingDurationMinutes?: number;
  calendarEventId?: string;
}): Thread {
  return upsertThread(params);
}
