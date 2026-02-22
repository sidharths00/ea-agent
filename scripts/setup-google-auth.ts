/**
 * One-time script to obtain a Google OAuth2 refresh token.
 *
 * Run: npm run setup:google
 *
 * Then visit the printed URL, authorize, paste the code back,
 * and copy the refresh token into your .env file.
 */

import "dotenv/config";
import { google } from "googleapis";
import * as readline from "readline";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("❌  Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file first.");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
];

const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI ?? "http://localhost:3001/oauth/callback"
);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // force refresh_token to be returned
});

console.log("\n1. Open this URL in your browser:\n");
console.log("   " + authUrl + "\n");
console.log('2. Authorize the app, then copy the "code" from the redirect URL.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste the authorization code here: ", async (code) => {
  rl.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    console.log("\n✅  Success! Add the following to your .env file:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log("\nKeep this token secret — it grants full calendar access.");
  } catch (err) {
    console.error("❌  Failed to exchange code for tokens:", err);
  }
});
