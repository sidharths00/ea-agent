import { getThread, upsertThread, findBookedByAttendee } from "../db/index.js";
import type { Thread, ThreadState, TimeSlot } from "../types.js";

export function toolGetThread(threadId: string): Thread | null {
  return getThread(threadId);
}

export function toolUpdateThreadState(params: {
  threadId: string;
  state: ThreadState;
  proposedSlots?: TimeSlot[];
  attendeeEmail?: string;
  meetingTitle?: string;
  meetingDurationMinutes?: number;
  calendarEventId?: string;
}): Thread {
  return upsertThread(params);
}

export function toolFindBookedByAttendee(attendeeEmail: string): Thread | null {
  return findBookedByAttendee(attendeeEmail);
}
