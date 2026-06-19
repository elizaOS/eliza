import { extractBody, sanitizeHeaderValue } from "../../utils/google-mcp-shared";
import type { OAuthConnectionRole } from "../oauth/types";
import {
  fail,
  getManagedGoogleConnectorStatus,
  googleFetch,
  type ManagedGoogleGmailMessage,
  type ManagedGoogleGmailReadResult,
  type ManagedGoogleGmailSearchResult,
  type ManagedGoogleGmailSubscriptionHeader,
  type ManagedGoogleGmailSubscriptionHeadersResult,
} from "./shared";

const GOOGLE_GMAIL_MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GOOGLE_GMAIL_SEND_ENDPOINT = `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/send`;
const GMAIL_METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Date",
  "Reply-To",
  "Message-Id",
  "References",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
] as const;
const GMAIL_SUBSCRIPTION_METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Date",
  "List-Id",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "Precedence",
  "Auto-Submitted",
] as const;

type GoogleGmailMetadataHeader = {
  name?: string;
  value?: string;
};

type GoogleGmailMetadataResponse = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  sizeEstimate?: number;
  payload?: Record<string, unknown> & {
    headers?: GoogleGmailMetadataHeader[];
    mimeType?: string;
    body?: {
      data?: string;
    };
    parts?: Array<Record<string, unknown>>;
  };
};

type GoogleGmailListResponse = {
  messages?: Array<{
    id?: string;
    threadId?: string;
  }>;
};

function splitMailboxHeader(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === "<") {
      angleDepth += 1;
      current += char;
      continue;
    }
    if (!inQuotes && char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
      current += char;
      continue;
    }
    if (!inQuotes && angleDepth === 0 && char === ",") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    parts.push(trimmed);
  }
  return parts;
}

function stripQuotedDisplayName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseMailbox(value: string): {
  display: string;
  email: string | null;
} {
  const trimmed = value.trim();
  const match = trimmed.match(/^(.*?)(?:<([^>]+)>)$/);
  if (match) {
    const display = stripQuotedDisplayName(match[1] ?? "").trim();
    const email = (match[2] ?? "").trim().toLowerCase();
    return {
      display: display || email,
      email: email.length > 0 ? email : null,
    };
  }
  const normalized = stripQuotedDisplayName(trimmed);
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return {
      display: normalized,
      email: normalized.toLowerCase(),
    };
  }
  return {
    display: normalized,
    email: null,
  };
}

function parseMailboxList(value: string | undefined) {
  if (!value) return [];
  return splitMailboxHeader(value)
    .map((entry) => parseMailbox(entry))
    .filter((entry) => entry.display.length > 0 || entry.email !== null);
}

function readHeaderValue(
  headers: GoogleGmailMetadataHeader[] | undefined,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  const header = headers?.find((candidate) => candidate.name?.trim().toLowerCase() === lowerName);
  const value = header?.value?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeSnippet(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() || "";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|li|tr|table|h[1-6])>/gi, "\n")
      .replace(/<(?:li)[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeManagedGmailBodyText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    return htmlToPlainText(trimmed);
  }
  return trimmed.replace(/\r\n/g, "\n").trim();
}

function deriveHtmlLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function classifyReplyNeed(args: {
  labels: string[];
  fromEmail: string | null;
  to: string[];
  cc: string[];
  selfEmail: string | null;
  precedence: string | undefined;
  listId: string | undefined;
  autoSubmitted: string | undefined;
}) {
  const labels = new Set(args.labels.map((label) => label.trim().toUpperCase()));
  const isUnread = labels.has("UNREAD");
  const explicitlyImportant = labels.has("IMPORTANT");
  const selfEmail = args.selfEmail?.trim().toLowerCase() || null;
  const fromEmail = args.fromEmail?.trim().toLowerCase() || null;
  const directRecipients = [...args.to, ...args.cc].map((entry) => entry.trim().toLowerCase());
  const directlyAddressed = selfEmail ? directRecipients.includes(selfEmail) : false;
  const fromSelf = Boolean(selfEmail && fromEmail && selfEmail === fromEmail);
  const precedence = args.precedence?.trim().toLowerCase();
  const autoSubmitted = args.autoSubmitted?.trim().toLowerCase();
  const automated =
    Boolean(
      fromEmail &&
        /(?:^|\b)(?:no-?reply|donotreply|notifications?|mailer-daemon)(?:\b|@)/i.test(fromEmail),
    ) ||
    Boolean(args.listId) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    (autoSubmitted !== undefined && autoSubmitted !== "no");

  let triageScore = 0;
  const reasons: string[] = [];

  if (isUnread) {
    triageScore += 30;
    reasons.push("unread");
  }
  if (explicitlyImportant) {
    triageScore += 35;
    reasons.push("important label");
  }
  if (directlyAddressed) {
    triageScore += 15;
    reasons.push("directly addressed");
  }
  if (!automated && !fromSelf && isUnread && directlyAddressed) {
    triageScore += 30;
    reasons.push("likely needs reply");
  }
  if (automated) {
    triageScore -= 25;
    reasons.push("automated sender");
  }
  if (fromSelf) {
    triageScore -= 60;
    reasons.push("sent by self");
  }

  return {
    likelyReplyNeeded: !automated && !fromSelf && isUnread && directlyAddressed,
    isImportant: explicitlyImportant || (!automated && !fromSelf && isUnread && directlyAddressed),
    triageScore: Math.max(0, triageScore),
    triageReason: reasons.join(", ") || "recent inbox message",
  };
}

function normalizeGoogleGmailMessage(
  message: GoogleGmailMetadataResponse,
  selfEmail: string | null,
): ManagedGoogleGmailMessage | null {
  const externalId = message.id?.trim();
  const threadId = message.threadId?.trim();
  if (!externalId || !threadId) {
    return null;
  }

  const headers = message.payload?.headers ?? [];
  const subject = readHeaderValue(headers, "Subject") || "(no subject)";
  const fromHeader = readHeaderValue(headers, "From") || "Unknown sender";
  const fromMailbox = parseMailbox(fromHeader);
  const replyToHeader = readHeaderValue(headers, "Reply-To");
  const replyToMailbox = replyToHeader ? parseMailbox(replyToHeader) : null;
  const to = parseMailboxList(readHeaderValue(headers, "To")).map(
    (entry) => entry.email || entry.display,
  );
  const cc = parseMailboxList(readHeaderValue(headers, "Cc")).map(
    (entry) => entry.email || entry.display,
  );
  const labels = (message.labelIds ?? []).map((label) => label.trim()).filter(Boolean);
  const receivedAtMs = Number(message.internalDate);
  const receivedAt = Number.isFinite(receivedAtMs)
    ? new Date(receivedAtMs).toISOString()
    : new Date().toISOString();
  const precedence = readHeaderValue(headers, "Precedence");
  const listId = readHeaderValue(headers, "List-Id");
  const autoSubmitted = readHeaderValue(headers, "Auto-Submitted");
  const triage = classifyReplyNeed({
    labels,
    fromEmail: fromMailbox.email,
    to,
    cc,
    selfEmail,
    precedence,
    listId,
    autoSubmitted,
  });

  return {
    externalId,
    threadId,
    subject,
    from: fromMailbox.display,
    fromEmail: fromMailbox.email,
    replyTo: replyToMailbox?.email || replyToMailbox?.display || null,
    to,
    cc,
    snippet: normalizeSnippet(message.snippet),
    receivedAt,
    isUnread: labels.includes("UNREAD"),
    isImportant: triage.isImportant,
    likelyReplyNeeded: triage.likelyReplyNeeded,
    triageScore: triage.triageScore,
    triageReason: triage.triageReason,
    labels,
    htmlLink: deriveHtmlLink(threadId),
    metadata: {
      historyId: message.historyId?.trim() || null,
      sizeEstimate: typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
      dateHeader: readHeaderValue(headers, "Date") || null,
      messageIdHeader: readHeaderValue(headers, "Message-Id") || null,
      referencesHeader: readHeaderValue(headers, "References") || null,
      listId: listId || null,
      precedence: precedence || null,
      autoSubmitted: autoSubmitted || null,
    },
  };
}

function normalizeGoogleGmailSubscriptionHeader(
  message: GoogleGmailMetadataResponse,
): ManagedGoogleGmailSubscriptionHeader | null {
  const messageId = message.id?.trim();
  const threadId = message.threadId?.trim();
  if (!messageId || !threadId) {
    return null;
  }

  const headers = message.payload?.headers ?? [];
  const from = parseMailbox(readHeaderValue(headers, "From") || "Unknown sender");
  const receivedAtMs = Number(message.internalDate);
  return {
    messageId,
    threadId,
    receivedAt: Number.isFinite(receivedAtMs)
      ? new Date(receivedAtMs).toISOString()
      : new Date().toISOString(),
    subject: readHeaderValue(headers, "Subject") || "(no subject)",
    fromDisplay: from.display,
    fromEmail: from.email,
    listId: readHeaderValue(headers, "List-Id") || null,
    listUnsubscribe: readHeaderValue(headers, "List-Unsubscribe") || null,
    listUnsubscribePost: readHeaderValue(headers, "List-Unsubscribe-Post") || null,
    snippet: normalizeSnippet(message.snippet),
    labels: (message.labelIds ?? []).map((label) => label.trim()).filter(Boolean),
  };
}

function normalizeReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return "Re: your message";
  }
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function hasGmailBodyReadScope(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return (
    granted.has("https://www.googleapis.com/auth/gmail.readonly") ||
    granted.has("https://www.googleapis.com/auth/gmail.modify") ||
    granted.has("https://mail.google.com/")
  );
}

async function fetchManagedGoogleGmailMessages(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  maxResults: number;
  selfEmail: string | null;
  query?: string;
  labelIds?: string[];
}): Promise<ManagedGoogleGmailMessage[]> {
  const listParams = new URLSearchParams({
    maxResults: String(Math.min(Math.max(args.maxResults, 1), 50)),
    includeSpamTrash: "false",
  });
  for (const labelId of args.labelIds ?? []) {
    listParams.append("labelIds", labelId);
  }
  if (args.query?.trim()) {
    listParams.set("q", args.query.trim());
  }

  const listResponse = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}?${listParams.toString()}`,
  });
  const listed = (await listResponse.json()) as GoogleGmailListResponse;

  const messages = await Promise.all(
    (listed.messages ?? []).map(async (messageRef) => {
      const messageId = messageRef.id?.trim();
      if (!messageId) return null;
      const params = new URLSearchParams({ format: "metadata" });
      for (const header of GMAIL_METADATA_HEADERS) {
        params.append("metadataHeaders", header);
      }
      const response = await googleFetch({
        organizationId: args.organizationId,
        userId: args.userId,
        side: args.side,
        grantId: args.grantId,
        url: `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(messageId)}?${params.toString()}`,
      });
      const parsed = (await response.json()) as GoogleGmailMetadataResponse;
      return normalizeGoogleGmailMessage(parsed, args.selfEmail);
    }),
  );

  return messages.filter((message): message is ManagedGoogleGmailMessage => message !== null);
}

export async function fetchManagedGoogleGmailTriage(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  maxResults: number;
}): Promise<ManagedGoogleGmailSearchResult> {
  const maxResults = Math.min(Math.max(args.maxResults, 1), 50);
  const connectorStatus = await getManagedGoogleConnectorStatus({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
  });
  const selfEmail =
    connectorStatus.identity && typeof connectorStatus.identity.email === "string"
      ? connectorStatus.identity.email
      : null;
  const messages = await fetchManagedGoogleGmailMessages({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    maxResults,
    selfEmail,
    labelIds: ["INBOX"],
  });

  return {
    messages: messages.sort((left, right) => {
      const scoreDelta = right.triageScore - left.triageScore;
      if (scoreDelta !== 0) return scoreDelta;
      return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
    }),
    syncedAt: new Date().toISOString(),
  };
}

export async function fetchManagedGoogleGmailSearch(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  query: string;
  maxResults: number;
}): Promise<ManagedGoogleGmailSearchResult> {
  const maxResults = Math.min(Math.max(args.maxResults, 1), 50);
  const query = args.query.trim();
  if (query.length === 0) {
    fail(400, "query is required.");
  }

  const connectorStatus = await getManagedGoogleConnectorStatus({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
  });
  if (!hasGmailBodyReadScope(connectorStatus.grantedScopes)) {
    fail(
      409,
      "This Google connection only has Gmail metadata access. Reconnect Google to grant Gmail read access so Agent can search your full mailbox.",
    );
  }
  const selfEmail =
    connectorStatus.identity && typeof connectorStatus.identity.email === "string"
      ? connectorStatus.identity.email
      : null;

  return {
    messages: await fetchManagedGoogleGmailMessages({
      organizationId: args.organizationId,
      userId: args.userId,
      side: args.side,
      grantId: args.grantId,
      maxResults,
      selfEmail,
      query,
    }),
    syncedAt: new Date().toISOString(),
  };
}

export async function fetchManagedGoogleGmailSubscriptionHeaders(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  query: string;
  maxResults: number;
}): Promise<ManagedGoogleGmailSubscriptionHeadersResult> {
  const maxResults = Math.min(Math.max(args.maxResults, 1), 200);
  const query = args.query.trim();
  if (query.length === 0) {
    fail(400, "query is required.");
  }

  const connectorStatus = await getManagedGoogleConnectorStatus({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
  });
  if (!hasGmailBodyReadScope(connectorStatus.grantedScopes)) {
    fail(
      409,
      "This Google connection only has Gmail metadata access. Reconnect Google to grant Gmail read access so Agent can scan subscription senders.",
    );
  }

  const listParams = new URLSearchParams({
    maxResults: String(maxResults),
    includeSpamTrash: "false",
    q: query,
  });
  const listResponse = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}?${listParams.toString()}`,
  });
  const listed = (await listResponse.json()) as GoogleGmailListResponse;

  const headers = await Promise.all(
    (listed.messages ?? []).map(async (messageRef) => {
      const messageId = messageRef.id?.trim();
      if (!messageId) {
        return null;
      }
      const params = new URLSearchParams({ format: "metadata" });
      for (const header of GMAIL_SUBSCRIPTION_METADATA_HEADERS) {
        params.append("metadataHeaders", header);
      }
      const response = await googleFetch({
        organizationId: args.organizationId,
        userId: args.userId,
        side: args.side,
        grantId: args.grantId,
        url: `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(messageId)}?${params.toString()}`,
      });
      const parsed = (await response.json()) as GoogleGmailMetadataResponse;
      return normalizeGoogleGmailSubscriptionHeader(parsed);
    }),
  );

  return {
    headers: headers.filter(
      (header): header is ManagedGoogleGmailSubscriptionHeader => header !== null,
    ),
    syncedAt: new Date().toISOString(),
  };
}

export async function readManagedGoogleGmailMessage(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  messageId: string;
}): Promise<ManagedGoogleGmailReadResult> {
  const connectorStatus = await getManagedGoogleConnectorStatus({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
  });
  if (!hasGmailBodyReadScope(connectorStatus.grantedScopes)) {
    fail(
      409,
      "This Google connection only has Gmail metadata access. Reconnect Google to grant Gmail read access so Agent can read email bodies.",
    );
  }
  const selfEmail =
    connectorStatus.identity && typeof connectorStatus.identity.email === "string"
      ? connectorStatus.identity.email
      : null;
  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(args.messageId)}?format=full`,
  });
  const parsed = (await response.json()) as GoogleGmailMetadataResponse;
  const message = normalizeGoogleGmailMessage(parsed, selfEmail);
  if (!message) {
    fail(502, "Google Gmail returned a partial message payload.");
  }
  const rawBody = parsed.payload ? extractBody(parsed.payload) : "";
  return {
    message,
    bodyText: normalizeManagedGmailBodyText(rawBody) || message.snippet,
  };
}

export async function sendManagedGoogleReply(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string | null;
  references?: string | null;
}): Promise<void> {
  const lines = [
    `To: ${sanitizeHeaderValue(args.to.join(", "))}`,
    ...(args.cc && args.cc.length > 0 ? [`Cc: ${sanitizeHeaderValue(args.cc.join(", "))}`] : []),
    `Subject: ${sanitizeHeaderValue(normalizeReplySubject(args.subject))}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    ...(args.inReplyTo ? [`In-Reply-To: ${sanitizeHeaderValue(args.inReplyTo)}`] : []),
    ...(args.references ? [`References: ${sanitizeHeaderValue(args.references)}`] : []),
    "",
    args.bodyText.replace(/\r?\n/g, "\r\n"),
  ];
  const raw = Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");

  await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: GOOGLE_GMAIL_SEND_ENDPOINT,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    },
  });
}

export async function sendManagedGoogleMessage(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
}): Promise<void> {
  const lines = [
    `To: ${sanitizeHeaderValue(args.to.join(", "))}`,
    ...(args.cc && args.cc.length > 0 ? [`Cc: ${sanitizeHeaderValue(args.cc.join(", "))}`] : []),
    ...(args.bcc && args.bcc.length > 0
      ? [`Bcc: ${sanitizeHeaderValue(args.bcc.join(", "))}`]
      : []),
    `Subject: ${sanitizeHeaderValue(args.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    args.bodyText.replace(/\r?\n/g, "\r\n"),
  ];
  const raw = Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");

  await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: GOOGLE_GMAIL_SEND_ENDPOINT,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    },
  });
}
