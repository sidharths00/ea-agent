/**
 * Interactively seed your scheduling preferences into the database.
 * Run: npm run seed:prefs
 */

import "dotenv/config";
import * as readline from "readline";
import { setPreference } from "../src/db/index.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${question} [${defaultVal}]: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function main() {
  console.log("\n🗓  EA Agent — Preference Setup\n");
  console.log("Press Enter to accept the default value shown in brackets.\n");

  const prefs: Record<string, string> = {
    workingHoursStart:           await ask("Working hours start (HH:MM)", "09:00"),
    workingHoursEnd:             await ask("Working hours end (HH:MM)", "18:00"),
    timezone:                    await ask("Timezone (IANA)", process.env.OWNER_TIMEZONE ?? "America/Los_Angeles"),
    defaultMeetingDurationMinutes: await ask("Default meeting duration (minutes)", "30"),
    bufferBeforeMinutes:         await ask("Buffer before meetings (minutes)", "5"),
    bufferAfterMinutes:          await ask("Buffer after meetings (minutes)", "5"),
    preferredPlatform:           await ask("Preferred video platform (Google Meet / Zoom / phone)", "Google Meet"),
    maxMeetingsPerDay:           await ask("Max meetings per day", "6"),
    noMeetingDays:               await ask("No-meeting days (JSON array, 0=Sun … 6=Sat)", "[0,6]"),
  };

  for (const [key, value] of Object.entries(prefs)) {
    setPreference(key, value);
  }

  console.log("\n✅  Preferences saved!\n");
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
