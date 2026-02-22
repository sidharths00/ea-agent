import { google } from "googleapis";
import type { Preferences, TimeSlot } from "../types.js";

function getAuthClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

export interface AvailabilityResult {
  freeSlots: TimeSlot[];
  timezone: string;
}

/**
 * Returns a list of free time slots within the given date range,
 * filtered against the user's preferences (working hours, buffers, etc.)
 */
export async function toolGetAvailability(
  startDate: string, // ISO date: "YYYY-MM-DD"
  endDate: string,   // ISO date: "YYYY-MM-DD" (inclusive)
  prefs: Preferences,
  durationMinutes: number
): Promise<AvailabilityResult> {
  const calendar = google.calendar({ version: "v3", auth: getAuthClient() });

  const timeMin = new Date(`${startDate}T00:00:00`);
  const timeMax = new Date(`${endDate}T23:59:59`);

  // Fetch all calendars the user has access to (primary + subscribed work calendars)
  const calListRes = await calendar.calendarList.list();
  const calendarIds = (calListRes.data.items ?? [])
    .filter((cal) => cal.accessRole !== "freeBusyReader") // skip read-only subscriptions with no event detail
    .map((cal) => cal.id!);

  // Query events across all calendars and merge
  const allEvents = await Promise.all(
    calendarIds.map((calId) =>
      calendar.events.list({
        calendarId: calId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      }).then((res) => res.data.items ?? [])
    )
  );

  const busyBlocks: TimeSlot[] = allEvents.flat()
    .filter((event) => {
      if (!event.start?.dateTime) return false; // skip all-day events
      if (event.status === "cancelled") return false;
      const myResponse = event.attendees?.find((a) => a.self)?.responseStatus;
      if (myResponse === "declined") return false;
      return true;
    })
    .map((event) => ({ start: event.start!.dateTime!, end: event.end!.dateTime! }));

  console.log("[calendar] Calendars queried:", calendarIds);
  console.log("[calendar] Busy blocks:", JSON.stringify(busyBlocks));

  const freeSlots = computeFreeSlots({
    busyBlocks,
    startDate,
    endDate,
    prefs,
    durationMinutes,
  });

  return { freeSlots, timezone: prefs.timezone };
}

/**
 * Returns contiguous free windows per day (e.g. "10:05 AM – 2:55 PM"),
 * each long enough to fit at least one meeting of durationMinutes.
 * Buffers are applied around each busy block before subtracting.
 */
function computeFreeSlots(params: {
  busyBlocks: TimeSlot[];
  startDate: string;
  endDate: string;
  prefs: Preferences;
  durationMinutes: number;
}): TimeSlot[] {
  const { busyBlocks, startDate, endDate, prefs, durationMinutes } = params;

  const [startHour, startMin] = prefs.workingHoursStart.split(":").map(Number);
  const [endHour, endMin] = prefs.workingHoursEnd.split(":").map(Number);
  const minWindowMs = durationMinutes * 60 * 1000;

  const freeWindows: TimeSlot[] = [];

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  for (
    const day = new Date(start);
    day <= end;
    day.setDate(day.getDate() + 1)
  ) {
    if (prefs.noMeetingDays.includes(day.getDay())) continue;

    const dayStart = new Date(day);
    dayStart.setHours(startHour, startMin, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(endHour, endMin, 0, 0);

    // Clamp busy blocks to working hours, no buffers applied
    const blocked = busyBlocks
      .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
      .filter((b) => b.start < dayEnd && b.end > dayStart)
      .map((b) => ({
        start: b.start < dayStart ? dayStart : b.start,
        end: b.end > dayEnd ? dayEnd : b.end,
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    // Walk gaps between blocked intervals
    let cursor = dayStart;
    for (const block of blocked) {
      if (cursor < block.start) {
        const windowMs = block.start.getTime() - cursor.getTime();
        if (windowMs >= minWindowMs) {
          freeWindows.push({ start: cursor.toISOString(), end: block.start.toISOString() });
        }
      }
      if (block.end > cursor) cursor = block.end;
    }
    // Remaining time after last block
    if (cursor < dayEnd) {
      const windowMs = dayEnd.getTime() - cursor.getTime();
      if (windowMs >= minWindowMs) {
        freeWindows.push({ start: cursor.toISOString(), end: dayEnd.toISOString() });
      }
    }
  }

  return freeWindows;
}

export interface BookingResult {
  eventId: string;
  eventLink: string;
  meetLink?: string;
}

export async function toolUpdateCalendarEvent(
  eventId: string,
  params: { start: string; end: string; title?: string; description?: string }
): Promise<void> {
  const calendar = google.calendar({ version: "v3", auth: getAuthClient() });
  await calendar.events.patch({
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary",
    eventId,
    sendUpdates: "all",
    requestBody: {
      ...(params.title && { summary: params.title }),
      ...(params.description !== undefined && { description: params.description }),
      start: { dateTime: params.start },
      end: { dateTime: params.end },
    },
  });
}

export async function toolCreateCalendarEvent(params: {
  title: string;
  start: string;   // ISO 8601
  end: string;     // ISO 8601
  attendeeEmail: string;
  attendeeName?: string;
  description?: string;
  addGoogleMeet?: boolean;
}): Promise<BookingResult> {
  const calendar = google.calendar({ version: "v3", auth: getAuthClient() });

  const event = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary",
    sendUpdates: "all",
    requestBody: {
      summary: params.title,
      description: params.description,
      start: { dateTime: params.start },
      end: { dateTime: params.end },
      attendees: [{ email: params.attendeeEmail, displayName: params.attendeeName }],
      ...(params.addGoogleMeet && {
        conferenceData: {
          createRequest: {
            requestId: `ea-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
    },
    conferenceDataVersion: params.addGoogleMeet ? 1 : 0,
  });

  const meetLink =
    event.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")
      ?.uri ?? undefined;

  return {
    eventId: event.data.id!,
    eventLink: event.data.htmlLink!,
    meetLink,
  };
}
