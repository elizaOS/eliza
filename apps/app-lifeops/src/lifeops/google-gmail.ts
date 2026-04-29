import type {
  LifeOpsGmailBulkOperation,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailUnrespondedThread,
} from "../contracts/index.js";
import { GoogleApiError } from "./google-api-error.js";
import { googleApiFetch } from "./google-fetch.js";
import { MAX_GMAIL_TRIAGE_MAX_RESULTS } from "./service-constants.js";

const GOOGLE_GMAIL_USER_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_GMAIL_MESSAGES_ENDPOINT =
  `${GOOGLE_GMAIL_USER_ENDPOINT}/messages`;
const GOOGLE_GMAIL_THREADS_ENDPOINT = `${GOOGLE_GMAIL_USER_ENDPOINT}/threads`;

const GMAIL_METADATA_HEADERS = [
  "Subject",
  "From",
  "To",
  "Cc",
  "Date",
  "Reply-To",
  "Message-Id",
  "References",
  "List-Unsubscribe",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
] as const;

interface GoogleGmailListResponse {
  messages?: Array<{
    id?: string;
    threadId?: string;
  }>;
  nextPageToken?: string;
}

interface GoogleGmailMetadataHeader {
  name?: string;
  value?: string;
}

interface GoogleGmailBody {
  data?: string;
}

interface GoogleGmailPayload {
  headers?: GoogleGmailMetadataHeader[];
  mimeType?: string;
  body?: GoogleGmailBody;
  parts?: GoogleGmailPayload[];
}

interface GoogleGmailMetadataResponse {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  sizeEstimate?: number;
  payload?: GoogleGmailPayload;
}

interface GoogleGmailThreadResponse {
  id?: string;
  messages?: GoogleGmailMetadataResponse[];
}

const GOOGLE_GMAIL_LIST_PAGE_SIZE = 500;
const GOOGLE_GMAIL_METADATA_CONCURRENCY = 25;

export interface SyncedGoogleGmailMessageSummary
  extends Omit<
    LifeOpsGmailMessageSummary,
    "id" | "agentId" | "provider" | "side" | "syncedAt" | "updatedAt"
  > {}

export interface SyncedGoogleGmailMessageDetail {
  message: SyncedGoogleGmailMessageSummary;
  bodyText: string;
}

export interface SyncedGoogleGmailUnrespondedThread
  extends Omit<
    LifeOpsGmailUnrespondedThread,
    "messageId" | "grantId" | "accountEmail"
  > {
  externalMessageId: string;
}

function readGoogleGmailErrorPrefix(status: number): string {
  return `Google Gmail request failed with ${status}`;
}

async function readGoogleGmailError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return readGoogleGmailErrorPrefix(response.status);
  }
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        message?: string;
      };
    };
    return parsed.error?.message || text;
  } catch {
    return text;
  }
}

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

function parseMailboxList(
  value: string | undefined,
): Array<{ display: string; email: string | null }> {
  if (!value) {
    return [];
  }
  return splitMailboxHeader(value)
    .map((entry) => parseMailbox(entry))
    .filter((entry) => entry.display.length > 0 || entry.email !== null);
}

function readHeaderValue(
  headers: GoogleGmailMetadataHeader[] | undefined,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  const header = headers?.find(
    (candidate) => candidate.name?.trim().toLowerCase() === lowerName,
  );
  const value = header?.value?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return "Re: your message";
  }
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function normalizeSnippet(value: string | undefined): string {
  if (!value) {
    return "";
  }
  // Gmail's snippet field arrives with raw HTML entities ("It&#39;s", "Tom
  // &amp; Jerry", "&nbsp;"). Decode them so the discord/UI render is plain
  // text instead of leaking entity codes to the user.
  return decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
}

function decodeGmailBodyData(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(paddingLength);
  return Buffer.from(padded, "base64").toString("utf-8");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
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

function extractGoogleGmailBodyByMime(
  payload: GoogleGmailPayload | undefined,
  mimeType: "text/plain" | "text/html",
): string {
  if (!payload) {
    return "";
  }

  const directBody = payload.body?.data;
  if (payload.mimeType === mimeType && typeof directBody === "string") {
    const decoded = decodeGmailBodyData(directBody);
    return mimeType === "text/html" ? htmlToPlainText(decoded) : decoded.trim();
  }

  for (const part of payload.parts ?? []) {
    const nested = extractGoogleGmailBodyByMime(part, mimeType);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function extractGoogleGmailBody(
  payload: GoogleGmailPayload | undefined,
): string {
  const plainText = extractGoogleGmailBodyByMime(payload, "text/plain");
  if (plainText) {
    return plainText;
  }
  const htmlText = extractGoogleGmailBodyByMime(payload, "text/html");
  if (htmlText) {
    return htmlText;
  }
  const directBody = payload?.body?.data;
  if (typeof directBody === "string") {
    const decoded = decodeGmailBodyData(directBody);
    return payload?.mimeType === "text/html"
      ? htmlToPlainText(decoded)
      : decoded.trim();
  }
  return "";
}

function deriveHtmlLink(threadId: string, accountEmail: string | null): string {
  const accountSegment =
    accountEmail && accountEmail.trim().length > 0
      ? encodeURIComponent(accountEmail.trim().toLowerCase())
      : "0";
  return `https://mail.google.com/mail/u/${accountSegment}/#all/${encodeURIComponent(threadId)}`;
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
}): {
  likelyReplyNeeded: boolean;
  isImportant: boolean;
  triageScore: number;
  triageReason: string;
} {
  const labels = new Set(
    args.labels.map((label) => label.trim().toUpperCase()),
  );
  const isUnread = labels.has("UNREAD");
  const explicitlyImportant = labels.has("IMPORTANT");
  const selfEmail = args.selfEmail?.trim().toLowerCase() || null;
  const fromEmail = args.fromEmail?.trim().toLowerCase() || null;
  const directRecipients = [...args.to, ...args.cc].map((entry) =>
    entry.trim().toLowerCase(),
  );
  const directlyAddressed = selfEmail
    ? directRecipients.includes(selfEmail)
    : false;
  const fromSelf = Boolean(selfEmail && fromEmail && selfEmail === fromEmail);
  const precedence = args.precedence?.trim().toLowerCase();
  const autoSubmitted = args.autoSubmitted?.trim().toLowerCase();
  const automated =
    Boolean(args.listId) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    precedence === "auto-reply" ||
    (autoSubmitted !== undefined && autoSubmitted !== "no");

  const likelyReplyNeeded =
    !automated && !fromSelf && isUnread && directlyAddressed;
  const isImportant = explicitlyImportant || likelyReplyNeeded;
  const triageSignals = [
    explicitlyImportant ? "gmail-important-label" : null,
    likelyReplyNeeded ? "direct-unread-reply-needed" : null,
    isUnread ? "unread" : null,
    automated ? "automated-header" : null,
    fromSelf ? "sent-by-self" : null,
  ].filter((value): value is string => Boolean(value));

  const triageScore = isImportant ? 2 : isUnread ? 1 : 0;
  const triageReason = triageSignals.join(", ") || "recent inbox message";

  return {
    likelyReplyNeeded,
    isImportant,
    triageScore,
    triageReason,
  };
}

function normalizeGoogleGmailMessage(
  message: GoogleGmailMetadataResponse,
  selfEmail: string | null,
): SyncedGoogleGmailMessageSummary | null {
  const externalId = message.id?.trim();
  const threadId = message.threadId?.trim();
  if (!externalId || !threadId) {
    return null;
  }

  const headers = message.payload?.headers ?? [];
  // Gmail subject headers can carry html entities (e.g. "Tom &amp; Jerry").
  // Decode them so the rendered subject reads naturally in discord/UI.
  const subject =
    decodeHtmlEntities(readHeaderValue(headers, "Subject") || "") ||
    "(no subject)";
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
  const labels = (message.labelIds ?? [])
    .map((label) => label.trim())
    .filter(Boolean);
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
    htmlLink: deriveHtmlLink(threadId, selfEmail),
    metadata: {
      historyId: message.historyId?.trim() || null,
      sizeEstimate:
        typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
      dateHeader: readHeaderValue(headers, "Date") || null,
      messageIdHeader: readHeaderValue(headers, "Message-Id") || null,
      referencesHeader: readHeaderValue(headers, "References") || null,
      listUnsubscribe: readHeaderValue(headers, "List-Unsubscribe") || null,
      listId: listId || null,
      precedence: precedence || null,
      autoSubmitted: autoSubmitted || null,
    },
  };
}

export async function fetchGoogleGmailTriageMessages(args: {
  accessToken: string;
  selfEmail?: string | null;
  maxResults?: number;
}): Promise<SyncedGoogleGmailMessageSummary[]> {
  return fetchGoogleGmailMessages({
    accessToken: args.accessToken,
    selfEmail: args.selfEmail ?? null,
    maxResults: args.maxResults,
    labelIds: ["INBOX"],
  });
}

export async function fetchGoogleGmailSearchMessages(args: {
  accessToken: string;
  selfEmail?: string | null;
  maxResults?: number;
  query: string;
  includeSpamTrash?: boolean;
}): Promise<SyncedGoogleGmailMessageSummary[]> {
  return fetchGoogleGmailMessages({
    accessToken: args.accessToken,
    selfEmail: args.selfEmail ?? null,
    maxResults: args.maxResults,
    query: args.query,
    includeSpamTrash: args.includeSpamTrash,
  });
}

export async function fetchGoogleGmailMessage(args: {
  accessToken: string;
  selfEmail?: string | null;
  messageId: string;
}): Promise<SyncedGoogleGmailMessageSummary | null> {
  const params = new URLSearchParams({
    format: "metadata",
  });
  for (const header of GMAIL_METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }
  let response: Response;
  try {
    response = await googleApiFetch(
      `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(args.messageId)}?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
        },
      },
    );
  } catch (error) {
    // A 404 here means the supplied messageId does not match any Gmail
    // message visible to this account — treat it the same as "no result"
    // so callers can render the standard "message not found" fallback
    // instead of leaking the raw Google error string.
    if (error instanceof GoogleApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
  const parsed = (await response.json()) as GoogleGmailMetadataResponse;
  return normalizeGoogleGmailMessage(parsed, args.selfEmail ?? null);
}

export async function fetchGoogleGmailThread(args: {
  accessToken: string;
  selfEmail?: string | null;
  threadId: string;
}): Promise<SyncedGoogleGmailMessageSummary[]> {
  const params = new URLSearchParams({
    format: "metadata",
  });
  for (const header of GMAIL_METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }
  const response = await googleApiFetch(
    `${GOOGLE_GMAIL_THREADS_ENDPOINT}/${encodeURIComponent(args.threadId)}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
      },
    },
  );
  const parsed = (await response.json()) as GoogleGmailThreadResponse;
  return (parsed.messages ?? [])
    .map((message) => normalizeGoogleGmailMessage(message, args.selfEmail ?? null))
    .filter(
      (message): message is SyncedGoogleGmailMessageSummary => message !== null,
    )
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
}

export async function fetchGoogleGmailMessageDetail(args: {
  accessToken: string;
  selfEmail?: string | null;
  messageId: string;
}): Promise<SyncedGoogleGmailMessageDetail | null> {
  const params = new URLSearchParams({
    format: "full",
  });
  let response: Response;
  try {
    response = await googleApiFetch(
      `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(args.messageId)}?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
        },
      },
    );
  } catch (error) {
    // 404 → treat as "no such message" so the caller's existing
    // "message not found" fallback handles the user-facing response,
    // instead of leaking the raw Google API error string.
    if (error instanceof GoogleApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
  const parsed = (await response.json()) as GoogleGmailMetadataResponse;
  const message = normalizeGoogleGmailMessage(parsed, args.selfEmail ?? null);
  if (!message) {
    return null;
  }
  return {
    message,
    bodyText: extractGoogleGmailBody(parsed.payload).trim() || message.snippet,
  };
}

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return [];
  const results = new Array<TResult>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchGoogleGmailMessageMetadata(args: {
  accessToken: string;
  selfEmail?: string | null;
  messageId?: string;
}): Promise<SyncedGoogleGmailMessageSummary | null> {
  const messageId = args.messageId?.trim();
  if (!messageId) return null;
  const params = new URLSearchParams({
    format: "metadata",
  });
  for (const header of GMAIL_METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }

  const response = await googleApiFetch(
    `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(messageId)}?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
      },
    },
  );
  const parsed = (await response.json()) as GoogleGmailMetadataResponse;
  return normalizeGoogleGmailMessage(parsed, args.selfEmail ?? null);
}

async function fetchGoogleGmailMessages(args: {
  accessToken: string;
  selfEmail?: string | null;
  maxResults?: number;
  query?: string;
  labelIds?: string[];
  includeSpamTrash?: boolean;
}): Promise<SyncedGoogleGmailMessageSummary[]> {
  const requestedMaxResults =
    typeof args.maxResults === "number" &&
    Number.isFinite(args.maxResults) &&
    args.maxResults > 0
      ? Math.trunc(args.maxResults)
      : 20;
  const maxResults = Math.min(
    requestedMaxResults,
    MAX_GMAIL_TRIAGE_MAX_RESULTS,
  );
  const messages: SyncedGoogleGmailMessageSummary[] = [];
  let pageToken: string | undefined;

  while (messages.length < maxResults) {
    const pageSize = Math.min(
      GOOGLE_GMAIL_LIST_PAGE_SIZE,
      maxResults - messages.length,
    );
    const listParams = new URLSearchParams({
      maxResults: String(pageSize),
      includeSpamTrash: args.includeSpamTrash === true ? "true" : "false",
    });
    for (const labelId of args.labelIds ?? []) {
      listParams.append("labelIds", labelId);
    }
    if (args.query?.trim()) {
      listParams.set("q", args.query.trim());
    }
    if (pageToken) {
      listParams.set("pageToken", pageToken);
    }

    const listResponse = await googleApiFetch(
      `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}?${listParams.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${args.accessToken}`,
        },
      },
    );

    const listed = (await listResponse.json()) as GoogleGmailListResponse;
    const pageMessages = await mapWithConcurrency(
      listed.messages ?? [],
      GOOGLE_GMAIL_METADATA_CONCURRENCY,
      async (messageRef) =>
        fetchGoogleGmailMessageMetadata({
          accessToken: args.accessToken,
          selfEmail: args.selfEmail ?? null,
          messageId: messageRef.id,
        }),
    );
    for (const message of pageMessages) {
      if (message) {
        messages.push(message);
      }
    }

    const nextPageToken = listed.nextPageToken?.trim();
    if (!nextPageToken || nextPageToken === pageToken) {
      break;
    }
    pageToken = nextPageToken;
  }

  return messages
    .slice(0, maxResults)
    .sort((left, right) => {
      if (left.isImportant !== right.isImportant) {
        return right.isImportant ? 1 : -1;
      }
      if (left.likelyReplyNeeded !== right.likelyReplyNeeded) {
        return right.likelyReplyNeeded ? 1 : -1;
      }
      if (left.isUnread !== right.isUnread) {
        return right.isUnread ? 1 : -1;
      }
      return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
    });
}

function isGoogleGmailMessageFromSelf(
  message: SyncedGoogleGmailMessageSummary,
  selfEmail: string | null,
): boolean {
  const labels = new Set(message.labels.map((label) => label.toUpperCase()));
  if (labels.has("SENT")) {
    return true;
  }
  const fromEmail = message.fromEmail?.trim().toLowerCase() || null;
  return Boolean(selfEmail && fromEmail && fromEmail === selfEmail);
}

function isGoogleGmailAutomatedMessage(
  message: SyncedGoogleGmailMessageSummary,
): boolean {
  const precedence =
    typeof message.metadata.precedence === "string"
      ? message.metadata.precedence.trim().toLowerCase()
      : "";
  const autoSubmitted =
    typeof message.metadata.autoSubmitted === "string"
      ? message.metadata.autoSubmitted.trim().toLowerCase()
      : "";
  return (
    Boolean(message.metadata.listId) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    precedence === "auto-reply" ||
    (autoSubmitted.length > 0 && autoSubmitted !== "no")
  );
}

export async function fetchGoogleGmailUnrespondedThreads(args: {
  accessToken: string;
  selfEmail?: string | null;
  olderThanDays?: number;
  maxResults?: number;
  now?: Date;
}): Promise<SyncedGoogleGmailUnrespondedThread[]> {
  const olderThanDays =
    typeof args.olderThanDays === "number" && args.olderThanDays > 0
      ? Math.min(Math.trunc(args.olderThanDays), 3650)
      : 3;
  const maxResults =
    typeof args.maxResults === "number" && args.maxResults > 0
      ? Math.min(Math.trunc(args.maxResults), 50)
      : 20;
  const now = args.now ?? new Date();
  const selfEmail = args.selfEmail?.trim().toLowerCase() || null;
  const sentCandidateLimit = Math.min(Math.max(maxResults * 5, maxResults), 250);
  const sentCandidates = await fetchGoogleGmailSearchMessages({
    accessToken: args.accessToken,
    selfEmail,
    maxResults: sentCandidateLimit,
    query: `in:sent older_than:${olderThanDays}d`,
  });
  const seenThreads = new Set<string>();
  const threads: SyncedGoogleGmailUnrespondedThread[] = [];

  for (const sentMessage of sentCandidates) {
    if (seenThreads.has(sentMessage.threadId)) {
      continue;
    }
    seenThreads.add(sentMessage.threadId);
    const threadMessages = await fetchGoogleGmailThread({
      accessToken: args.accessToken,
      selfEmail,
      threadId: sentMessage.threadId,
    });
    const humanMessages = threadMessages.filter(
      (message) => !isGoogleGmailAutomatedMessage(message),
    );
    const lastOutbound = [...humanMessages]
      .reverse()
      .find((message) => isGoogleGmailMessageFromSelf(message, selfEmail));
    if (!lastOutbound) {
      continue;
    }
    const lastOutboundAtMs = Date.parse(lastOutbound.receivedAt);
    if (!Number.isFinite(lastOutboundAtMs)) {
      continue;
    }
    const hasLaterInbound = humanMessages.some(
      (message) =>
        !isGoogleGmailMessageFromSelf(message, selfEmail) &&
        Date.parse(message.receivedAt) > lastOutboundAtMs,
    );
    if (hasLaterInbound) {
      continue;
    }
    const ageMs = now.getTime() - lastOutboundAtMs;
    if (ageMs < olderThanDays * 24 * 60 * 60 * 1000) {
      continue;
    }
    const lastInbound = [...humanMessages]
      .reverse()
      .find((message) => !isGoogleGmailMessageFromSelf(message, selfEmail));
    threads.push({
      threadId: lastOutbound.threadId,
      externalMessageId: lastOutbound.externalId,
      subject: lastOutbound.subject,
      to: lastOutbound.to,
      cc: lastOutbound.cc,
      lastOutboundAt: lastOutbound.receivedAt,
      lastInboundAt: lastInbound?.receivedAt ?? null,
      daysWaiting: Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000))),
      snippet: lastOutbound.snippet,
      labels: lastOutbound.labels,
      htmlLink: lastOutbound.htmlLink,
    });
  }

  return threads
    .sort((left, right) => right.daysWaiting - left.daysWaiting)
    .slice(0, maxResults);
}

function requireLabelIdsForGmailOperation(
  operation: LifeOpsGmailBulkOperation,
  labelIds: readonly string[] | undefined,
): string[] {
  const labels = (labelIds ?? [])
    .map((labelId) => labelId.trim())
    .filter(Boolean);
  if (
    (operation === "apply_label" || operation === "remove_label") &&
    labels.length === 0
  ) {
    throw new GoogleApiError(400, `${operation} requires at least one labelId`);
  }
  return labels;
}

export async function modifyGoogleGmailMessages(args: {
  accessToken: string;
  messageIds: readonly string[];
  operation: LifeOpsGmailBulkOperation;
  labelIds?: readonly string[];
}): Promise<void> {
  const ids = args.messageIds
    .map((messageId) => messageId.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new GoogleApiError(400, "Gmail operation requires message ids");
  }
  const headers = {
    Authorization: `Bearer ${args.accessToken}`,
    "Content-Type": "application/json",
  };
  const labelIds = requireLabelIdsForGmailOperation(
    args.operation,
    args.labelIds,
  );

  if (args.operation === "trash") {
    await Promise.all(
      ids.map((messageId) =>
        googleApiFetch(
          `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/${encodeURIComponent(messageId)}/trash`,
          { method: "POST", headers },
        ),
      ),
    );
    return;
  }

  if (args.operation === "delete") {
    await googleApiFetch(`${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/batchDelete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ids }),
    });
    return;
  }

  const labelsForOperation: Record<
    LifeOpsGmailBulkOperation,
    { addLabelIds?: string[]; removeLabelIds?: string[] }
  > = {
    archive: { removeLabelIds: ["INBOX"] },
    trash: {},
    delete: {},
    report_spam: { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] },
    mark_read: { removeLabelIds: ["UNREAD"] },
    mark_unread: { addLabelIds: ["UNREAD"] },
    apply_label: { addLabelIds: labelIds },
    remove_label: { removeLabelIds: labelIds },
  };
  const labelPatch = labelsForOperation[args.operation];
  await googleApiFetch(`${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/batchModify`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ids,
      ...(labelPatch.addLabelIds && labelPatch.addLabelIds.length > 0
        ? { addLabelIds: labelPatch.addLabelIds }
        : {}),
      ...(labelPatch.removeLabelIds && labelPatch.removeLabelIds.length > 0
        ? { removeLabelIds: labelPatch.removeLabelIds }
        : {}),
    }),
  });
}

export interface GmailSendResult {
  /** Gmail message ID returned by the API (e.g. "18f3a..."). */
  messageId: string | null;
  /** Gmail thread ID. */
  threadId: string | null;
  /** Label IDs assigned by Gmail. */
  labelIds: string[];
}

async function postGoogleGmailRaw(
  accessToken: string,
  rawMessage: string,
): Promise<GmailSendResult> {
  const response = await googleApiFetch(
    `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: rawMessage }),
    },
  );

  // The Gmail API returns the sent message metadata on success.
  // Parse it so callers can verify the send and store the message ID.
  try {
    const data = (await response.json()) as {
      id?: string;
      threadId?: string;
      labelIds?: string[];
    };
    return {
      messageId: typeof data.id === "string" ? data.id : null,
      threadId: typeof data.threadId === "string" ? data.threadId : null,
      labelIds: Array.isArray(data.labelIds) ? data.labelIds : [],
    };
  } catch {
    // Response was 2xx but body wasn't valid JSON — unusual but not fatal.
    return { messageId: null, threadId: null, labelIds: [] };
  }
}

function encodeGmailRfc822(lines: string[]): string {
  return Buffer.from(lines.join("\r\n"), "utf-8").toString("base64url");
}

export async function sendGoogleGmailReply(args: {
  accessToken: string;
  to: string[];
  cc?: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string | null;
  references?: string | null;
}): Promise<GmailSendResult> {
  const lines = [
    `To: ${args.to.join(", ")}`,
    ...(args.cc && args.cc.length > 0 ? [`Cc: ${args.cc.join(", ")}`] : []),
    `Subject: ${normalizeReplySubject(args.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    ...(args.inReplyTo ? [`In-Reply-To: ${args.inReplyTo}`] : []),
    ...(args.references ? [`References: ${args.references}`] : []),
    "",
    args.bodyText.replace(/\r?\n/g, "\r\n"),
  ];
  return postGoogleGmailRaw(args.accessToken, encodeGmailRfc822(lines));
}

export async function sendGoogleGmailMessage(args: {
  accessToken: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
}): Promise<GmailSendResult> {
  const subject = args.subject.trim() || "(no subject)";
  const lines = [
    `To: ${args.to.join(", ")}`,
    ...(args.cc && args.cc.length > 0 ? [`Cc: ${args.cc.join(", ")}`] : []),
    ...(args.bcc && args.bcc.length > 0 ? [`Bcc: ${args.bcc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    args.bodyText.replace(/\r?\n/g, "\r\n"),
  ];
  return postGoogleGmailRaw(args.accessToken, encodeGmailRfc822(lines));
}
