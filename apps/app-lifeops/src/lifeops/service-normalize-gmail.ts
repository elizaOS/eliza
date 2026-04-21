import crypto from "node:crypto";
import type {
  LifeOpsCalendarEvent,
  LifeOpsConnectorGrant,
  LifeOpsGmailBatchReplyDraftsFeed,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailTriageFeed,
} from "@elizaos/shared/contracts/lifeops";
import {
  LIFEOPS_GMAIL_DRAFT_TONES,
} from "@elizaos/shared/contracts/lifeops";
import {
  fail,
  normalizeEnumValue,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  GOOGLE_CALENDAR_CACHE_TTL_MS,
  GOOGLE_GMAIL_CACHE_TTL_MS,
} from "./service-constants.js";
import type { SyncedGoogleGmailMessageSummary } from "./google-gmail.js";

export function normalizeGmailSearchQuery(value: unknown): string {
  const query = requireNonEmptyString(value, "query");
  if (query.length > 500) {
    fail(400, "query must be 500 characters or fewer");
  }
  return query;
}

export function parseGmailRelativeDuration(value: string): number | null {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+)([dmy])$/);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  const days =
    unit === "d" ? amount : unit === "m" ? amount * 30 : amount * 365;
  return days * 24 * 60 * 60 * 1000;
}

export function parseGmailDateBoundary(value: string): number | null {
  const normalized = value.trim().replace(/\//g, "-");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

export function splitMailboxLikeList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
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
    if (!inQuotes && angleDepth === 0 && char === "|" && next === "|") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      current = "";
      index += 1;
      continue;
    }
    if (
      !inQuotes &&
      angleDepth === 0 &&
      (char === "," || char === ";" || char === "\n")
    ) {
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

export function extractNormalizedEmailAddress(value: string): string | null {
  const trimmed = value.trim().replace(/^mailto:/i, "");
  if (!trimmed) {
    return null;
  }
  const angleMatch = trimmed.match(/<\s*([^<>\s@]+@[^<>\s@]+)\s*>/u);
  const rawCandidate =
    angleMatch?.[1] ??
    trimmed.match(/([^\s<>()"';,]+@[^\s<>()"';,]+)/u)?.[1] ??
    trimmed;
  const normalized = rawCandidate
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/[>;,\s]+$/g, "")
    .toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(normalized) ? normalized : null;
}

export function normalizeOptionalMessageIdArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    fail(400, `${field} must be an array`);
  }
  const items: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const item = requireNonEmptyString(candidate, `${field}[${index}]`);
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    items.push(item);
  }
  if (items.length > 50) {
    fail(400, `${field} must contain 50 items or fewer`);
  }
  return items;
}

export function normalizeGmailSearchQueryMatches(
  query: string,
  message: LifeOpsGmailMessageSummary,
): boolean {
  const all = [
    message.subject,
    message.from,
    message.fromEmail ?? "",
    message.replyTo ?? "",
    message.snippet,
    ...message.to,
    ...message.cc,
    ...message.labels,
  ]
    .join(" ")
    .toLowerCase();
  const sender = [message.from, message.fromEmail ?? "", message.replyTo ?? ""]
    .join(" ")
    .toLowerCase();
  const subject = message.subject.toLowerCase();
  const to = message.to.join(" ").toLowerCase();
  const cc = message.cc.join(" ").toLowerCase();
  const labels = message.labels.join(" ").toLowerCase();
  const receivedAtMs = Date.parse(message.receivedAt);
  const nowMs = Date.now();
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let braceDepth = 0;
  for (const char of query.trim()) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }
    if (!inQuotes && char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }
    if (!inQuotes && braceDepth === 0 && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return false;
  }

  const matchesToken = (token: string): boolean => {
    const normalizedToken = token.trim();
    if (normalizedToken.length === 0) {
      return true;
    }
    const isNegated = normalizedToken.startsWith("-");
    const tokenBody = isNegated
      ? normalizedToken.slice(1).trim()
      : normalizedToken;
    if (!tokenBody) {
      return true;
    }
    if (tokenBody.startsWith("{") && tokenBody.endsWith("}")) {
      const groupMembers = tokenBody
        .slice(1, -1)
        .trim()
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (groupMembers.length === 0) {
        return true;
      }
      const groupMatched = groupMembers.some((entry) => matchesToken(entry));
      return isNegated ? !groupMatched : groupMatched;
    }
    const operatorMatch = tokenBody.match(/^([a-z_]+):(.*)$/i);
    const rawValue = operatorMatch?.[2] ?? tokenBody;
    const value = rawValue.replace(/^"|"$/g, "").trim().toLowerCase();
    if (value.length === 0) {
      return true;
    }

    const labelTokens = message.labels.map((label) => label.toLowerCase());
    const hasAttachment =
      typeof message.metadata?.hasAttachments === "boolean"
        ? message.metadata.hasAttachments === true
        : /\battach(?:ed|ment|ments)?\b/i.test(
            `${message.subject} ${message.snippet}`,
          );
    const matched = (() => {
      if (!operatorMatch) {
        return all.includes(value);
      }

      const operator = (operatorMatch[1] ?? "").toLowerCase();
      switch (operator) {
        case "from":
          if (value === "me") {
            return labelTokens.includes("sent");
          }
          return sender.includes(value);
        case "subject":
          return subject.includes(value);
        case "to":
          return to.includes(value);
        case "cc":
          return cc.includes(value);
        case "label":
        case "labels":
          return labels.includes(value);
        case "category":
          return labelTokens.includes(`category_${value}`);
        case "in":
          return value === "anywhere" ? true : labelTokens.includes(value);
        case "has":
          return value === "attachment" ? hasAttachment : all.includes(value);
        case "is":
          if (value === "unread") {
            return message.isUnread;
          }
          if (value === "read") {
            return !message.isUnread;
          }
          if (value === "important") {
            return message.isImportant;
          }
          if (value === "starred") {
            return labelTokens.includes("starred");
          }
          return all.includes(value);
        case "newer_than": {
          const relativeMs = parseGmailRelativeDuration(value);
          return relativeMs === null
            ? all.includes(value)
            : receivedAtMs >= nowMs - relativeMs;
        }
        case "older_than": {
          const relativeMs = parseGmailRelativeDuration(value);
          return relativeMs === null
            ? all.includes(value)
            : receivedAtMs <= nowMs - relativeMs;
        }
        case "after": {
          const boundary = parseGmailDateBoundary(value);
          return boundary === null
            ? all.includes(value)
            : receivedAtMs >= boundary;
        }
        case "before": {
          const boundary = parseGmailDateBoundary(value);
          return boundary === null
            ? all.includes(value)
            : receivedAtMs < boundary;
        }
        default:
          return all.includes(value);
      }
    })();
    return isNegated ? !matched : matched;
  };

  return tokens.every((token) => {
    const normalizedToken = token.trim();
    if (normalizedToken.length === 0) {
      return true;
    }
    const operatorMatch = normalizedToken.match(/^([a-z_]+):(.*)$/i);
    const operator = operatorMatch?.[1]?.toLowerCase();
    const operatorValue = operatorMatch?.[2];
    if (operator === "or" && operatorValue) {
      return matchesToken(operatorValue);
    }
    return matchesToken(normalizedToken);
  });
}

export function filterGmailMessagesBySearch(args: {
  messages: LifeOpsGmailMessageSummary[];
  query?: string;
  replyNeededOnly?: boolean;
}): LifeOpsGmailMessageSummary[] {
  const query = normalizeOptionalString(args.query);
  const filtered = query
    ? args.messages.filter((message) =>
        normalizeGmailSearchQueryMatches(query, message),
      )
    : args.messages;
  const replyNeededOnly = args.replyNeededOnly === true;
  return filtered
    .filter((message) => !replyNeededOnly || message.likelyReplyNeeded)
    .sort(compareGmailMessagePriority);
}

export function compareGmailMessagePriority(
  left: LifeOpsGmailMessageSummary,
  right: LifeOpsGmailMessageSummary,
): number {
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
}

export function normalizeGmailDraftTone(value: unknown): "brief" | "neutral" | "warm" {
  return normalizeEnumValue(
    value ?? "neutral",
    "tone",
    LIFEOPS_GMAIL_DRAFT_TONES,
  );
}

export function normalizeOptionalStringArray(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? splitMailboxLikeList(value)
      : fail(400, `${field} must be an array or string`);
  const items: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of rawValues.entries()) {
    const source = requireNonEmptyString(candidate, `${field}[${index}]`);
    const item = extractNormalizedEmailAddress(source);
    if (!item) {
      fail(400, `${field}[${index}] must be a valid email address`);
    }
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    items.push(item);
  }
  return items;
}

export function normalizeGmailReplyBody(value: unknown): string {
  const body = requireNonEmptyString(value, "bodyText");
  if (body.length > 8000) {
    fail(400, "bodyText must be 8000 characters or fewer");
  }
  return body;
}

export function summarizeGmailSearch(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailSearchFeed["summary"] {
  return {
    totalCount: messages.length,
    unreadCount: messages.filter((message) => message.isUnread).length,
    importantCount: messages.filter((message) => message.isImportant).length,
    replyNeededCount: messages.filter((message) => message.likelyReplyNeeded)
      .length,
  };
}

export function summarizeGmailBatchReplyDrafts(
  drafts: LifeOpsGmailReplyDraft[],
): LifeOpsGmailBatchReplyDraftsFeed["summary"] {
  return {
    totalCount: drafts.length,
    sendAllowedCount: drafts.filter((draft) => draft.sendAllowed).length,
    requiresConfirmationCount: drafts.filter(
      (draft) => draft.requiresConfirmation,
    ).length,
  };
}

export function collectCalendarEventContactEmails(
  event: LifeOpsCalendarEvent,
): Set<string> {
  const emails = new Set<string>();
  const organizerEmail =
    typeof event.organizer?.email === "string"
      ? event.organizer.email.trim().toLowerCase()
      : "";
  if (organizerEmail) {
    emails.add(organizerEmail);
  }
  for (const attendee of event.attendees) {
    const email = attendee.email?.trim().toLowerCase() || "";
    if (email) {
      emails.add(email);
    }
  }
  return emails;
}

export function extractSubjectTokens(subject: string): string[] {
  return subject
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

export function findLinkedMailForCalendarEvent(
  event: LifeOpsCalendarEvent,
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailMessageSummary[] {
  const relatedEmails = collectCalendarEventContactEmails(event);
  const subjectTokens = new Set(extractSubjectTokens(event.title));

  return messages
    .filter((message) => {
      if (
        message.fromEmail &&
        relatedEmails.has(message.fromEmail.toLowerCase())
      ) {
        return true;
      }
      if (
        message.to.some((entry) =>
          relatedEmails.has(entry.trim().toLowerCase()),
        ) ||
        message.cc.some((entry) =>
          relatedEmails.has(entry.trim().toLowerCase()),
        )
      ) {
        return true;
      }
      const messageTokens = extractSubjectTokens(message.subject);
      return messageTokens.some((token) => subjectTokens.has(token));
    })
    .sort((left, right) => {
      const receivedDelta =
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
      if (receivedDelta !== 0) {
        return receivedDelta;
      }
      return compareGmailMessagePriority(left, right);
    })
    .slice(0, 3);
}

export function isGmailSyncStateFresh(args: {
  syncedAt: string;
  maxResults: number;
  requestedMaxResults: number;
  now: Date;
}): boolean {
  const syncedAtMs = Date.parse(args.syncedAt);
  if (!Number.isFinite(syncedAtMs)) {
    return false;
  }
  if (args.now.getTime() - syncedAtMs > GOOGLE_GMAIL_CACHE_TTL_MS) {
    return false;
  }
  return args.maxResults >= args.requestedMaxResults;
}

export function summarizeGmailTriage(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailTriageFeed["summary"] {
  return {
    unreadCount: messages.filter((message) => message.isUnread).length,
    importantNewCount: messages.filter(
      (message) => message.isUnread && message.isImportant,
    ).length,
    likelyReplyNeededCount: messages.filter(
      (message) => message.likelyReplyNeeded,
    ).length,
  };
}

export function summarizeGmailNeedsResponse(
  messages: LifeOpsGmailMessageSummary[],
): LifeOpsGmailNeedsResponseFeed["summary"] {
  return {
    totalCount: messages.length,
    unreadCount: messages.filter((message) => message.isUnread).length,
    importantCount: messages.filter((message) => message.isImportant).length,
  };
}

export function buildFallbackGmailReplyDraftBody(args: {
  message: LifeOpsGmailMessageSummary;
  tone: "brief" | "neutral" | "warm";
  intent?: string;
  includeQuotedOriginal: boolean;
  senderName: string;
}): string {
  const recipientLabel =
    args.message.from.split("<")[0]?.trim() || args.message.fromEmail || "";
  const greeting = recipientLabel ? `${recipientLabel},` : "";
  const subject = args.message.subject.trim() || "your message";
  const bodyCore = args.intent?.trim()
    ? args.intent.trim()
    : args.tone === "brief"
      ? `Thanks for the note about ${subject}. I saw it and will follow up shortly.`
      : args.tone === "warm"
        ? `Thanks for reaching out about ${subject}. I reviewed your note and wanted to follow up.`
        : `Thanks for the note about ${subject}. I reviewed your message and wanted to follow up.`;
  const bodyLines = [greeting, bodyCore, args.senderName].filter(
    (line) => line.trim().length > 0,
  );
  if (args.includeQuotedOriginal && args.message.snippet.trim().length > 0) {
    bodyLines.push(
      "",
      ...args.message.snippet
        .trim()
        .split("\n")
        .map((line) => `> ${line.trim()}`),
    );
  }

  return bodyLines.join("\n");
}

export function normalizeGeneratedGmailReplyDraftBody(value: string): string | null {
  const withoutThink = value.replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
  if (!withoutThink) {
    return null;
  }
  const withoutCodeFences = withoutThink
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const withoutSubject = withoutCodeFences.replace(/^subject:\s*.+\n+/i, "");
  const normalized = withoutSubject
    .replace(/\r\n/g, "\n")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

export function buildGmailReplyPreviewLines(bodyText: string): string[] {
  const lines = bodyText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3);
  return lines.length > 0 ? lines : [bodyText.trim()].filter(Boolean);
}

export function buildGmailReplyDraft(args: {
  message: LifeOpsGmailMessageSummary;
  senderName: string;
  sendAllowed: boolean;
  bodyText: string;
}): LifeOpsGmailReplyDraft {
  const recipient = args.message.replyTo ?? args.message.fromEmail ?? null;
  if (!recipient) {
    fail(409, "The selected Gmail message has no replyable sender.");
  }

  return {
    messageId: args.message.id,
    threadId: args.message.threadId,
    subject: args.message.subject,
    to: [recipient.toLowerCase()],
    cc: [],
    bodyText: args.bodyText,
    previewLines: buildGmailReplyPreviewLines(args.bodyText),
    sendAllowed: args.sendAllowed,
    requiresConfirmation: true,
  };
}

export function createCalendarEventId(
  agentId: string,
  provider: LifeOpsConnectorGrant["provider"],
  side: LifeOpsConnectorGrant["side"],
  calendarId: string,
  externalId: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${agentId}:${provider}:${side}:${calendarId}:${externalId}`)
    .digest("hex");
  return `life-calendar-${digest.slice(0, 32)}`;
}

export function createGmailMessageId(
  agentId: string,
  provider: LifeOpsConnectorGrant["provider"],
  side: LifeOpsConnectorGrant["side"],
  externalMessageId: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${agentId}:${provider}:${side}:gmail:${externalMessageId}`)
    .digest("hex");
  return `life-gmail-${digest.slice(0, 32)}`;
}

export function materializeGmailMessageSummary(args: {
  agentId: string;
  side: LifeOpsConnectorGrant["side"];
  message: SyncedGoogleGmailMessageSummary;
  syncedAt: string;
}): LifeOpsGmailMessageSummary {
  return {
    id: createGmailMessageId(
      args.agentId,
      "google",
      args.side,
      args.message.externalId,
    ),
    agentId: args.agentId,
    provider: "google",
    side: args.side,
    ...args.message,
    syncedAt: args.syncedAt,
    updatedAt: args.syncedAt,
  };
}

export function isCalendarSyncStateFresh(args: {
  syncedAt: string;
  timeMin: string;
  timeMax: string;
  windowStartAt: string;
  windowEndAt: string;
  now: Date;
}): boolean {
  const syncedAtMs = Date.parse(args.syncedAt);
  if (!Number.isFinite(syncedAtMs)) {
    return false;
  }
  if (args.now.getTime() - syncedAtMs > GOOGLE_CALENDAR_CACHE_TTL_MS) {
    return false;
  }
  return (
    Date.parse(args.windowStartAt) <= Date.parse(args.timeMin) &&
    Date.parse(args.windowEndAt) >= Date.parse(args.timeMax)
  );
}
