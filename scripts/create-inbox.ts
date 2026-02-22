/**
 * One-time script to create an AgentMail inbox.
 * Run: npx tsx scripts/create-inbox.ts
 *
 * On the free plan this creates an @agentmail.to address.
 * Upgrade to a paid plan to use a custom domain like ea@sidharths.com.
 *
 * After running, copy the printed inbox ID into your .env as AGENTMAIL_INBOX_ID.
 */

import "dotenv/config";
import { AgentMailClient } from "agentmail";

const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });

// On free plan: omit domain → defaults to @agentmail.to
// On paid plan: pass domain: "sidharths.com" for ea@sidharths.com
const inbox = await client.inboxes.create({
  username: "ea",
} as any);

console.log("\n✅  Inbox created!\n");
console.log(JSON.stringify(inbox, null, 2));
console.log('\nAdd this to your .env:\n');
console.log(`AGENTMAIL_INBOX_ID=${(inbox as any).inboxId ?? (inbox as any).id}`);
