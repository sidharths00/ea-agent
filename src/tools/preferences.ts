import { getPreferences, setPreference } from "../db/index.js";
import type { Preferences } from "../types.js";

export function toolGetPreferences(): Preferences {
  return getPreferences();
}

export function toolSetPreference(key: string, value: string): { success: boolean } {
  const validKeys: (keyof Preferences)[] = [
    "workingHoursStart",
    "workingHoursEnd",
    "timezone",
    "defaultMeetingDurationMinutes",
    "bufferBeforeMinutes",
    "bufferAfterMinutes",
    "preferredPlatform",
    "maxMeetingsPerDay",
    "noMeetingDays",
  ];

  if (!validKeys.includes(key as keyof Preferences)) {
    throw new Error(`Unknown preference key: ${key}`);
  }

  setPreference(key, value);
  return { success: true };
}
