import { AgentMailClient } from "agentmail";

let _client: AgentMailClient | null = null;

function getClient(): AgentMailClient {
  if (!_client) {
    _client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
  }
  return _client;
}

export interface SendEmailParams {
  to: string | string[];
  toName?: string;
  cc?: string | string[];
  subject: string;
  body: string;
  /** Pass the inbound messageId to thread the reply correctly */
  inReplyToMessageId?: string;
  /** Original email HTML to quote below the reply (preferred over quotedText) */
  quotedHtml?: string;
  /** Original email plain text to quote (fallback if no HTML) */
  quotedText?: string;
  /** "Name <email>" of the original sender for the quote header */
  quotedFrom?: string;
  /** ISO timestamp of the original email for the quote header */
  quotedDate?: string;
}

export async function toolSendEmail(params: SendEmailParams): Promise<{ success: boolean }> {
  const client = getClient();
  const inboxId = process.env.AGENTMAIL_INBOX_ID!;

  const toAddresses = Array.isArray(params.to) ? params.to : [params.to];
  const ccAddresses = params.cc
    ? Array.isArray(params.cc) ? params.cc : [params.cc]
    : undefined;

  const dateStr = params.quotedDate
    ? new Date(params.quotedDate).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })
    : "";
  const quoteHeader = params.quotedFrom ? `On ${dateStr}, ${params.quotedFrom} wrote:` : "";

  // Plain text version
  const quotedTextBlock = params.quotedText
    ? `\n\n${quoteHeader}\n${params.quotedText.split("\n").map((l) => `> ${l}`).join("\n")}`
    : "";
  const fullText = params.body + quotedTextBlock;

  // HTML version — use Gmail-style blockquote so the thread collapses properly
  const bodyHtml = params.body
    .split("\n")
    .map((l) => `<div>${l === "" ? "<br>" : escapeHtml(l)}</div>`)
    .join("\n");
  const quoteContent = params.quotedHtml ?? (params.quotedText
    ? `<pre style="margin:0;white-space:pre-wrap">${escapeHtml(params.quotedText)}</pre>`
    : null);
  const fullHtml = quoteContent
    ? `<div>${bodyHtml}</div><br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(quoteHeader)}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${quoteContent}</blockquote></div>`
    : `<div>${bodyHtml}</div>`;

  await (client.inboxes.messages.send as any)(inboxId, {
    to: toAddresses,
    ...(ccAddresses && { cc: ccAddresses }),
    subject: params.subject,
    text: fullText,
    html: fullHtml,
    ...(params.inReplyToMessageId && {
      inReplyTo: params.inReplyToMessageId,
    }),
  });

  return { success: true };
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One-time setup: create the ea@sidharths.com inbox */
export async function createInbox(username: string, domain: string): Promise<string> {
  const client = getClient();
  const inbox = await client.inboxes.create({ username, domain } as any);
  return (inbox as any).inboxId ?? (inbox as any).id;
}
