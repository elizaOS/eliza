import { and, eq } from "drizzle-orm";
import { dbRead } from "@/db/client";
import { platformCredentials } from "@/db/schemas/platform-credentials";
import { oauthService } from "@/lib/services/oauth";
import { getPreferredActiveConnection } from "@/lib/services/oauth/oauth-service";
import { getProvider, isProviderConfigured } from "@/lib/services/oauth/provider-registry";
import type { OAuthConnectionRole } from "@/lib/services/oauth/types";
import {
  applyTimeZone,
  extractBody,
  googleFetchWithToken,
  sanitizeHeaderValue,
} from "@/lib/utils/google-mcp-shared";

const GOOGLE_CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars";
const GOOGLE_CALENDAR_LIST_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const GOOGLE_GMAIL_MESSAGES_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GOOGLE_GMAIL_SEND_ENDPOINT = `${GOOGLE_GMAIL_MESSAGES_ENDPOINT}/send`;
const DEFAULT_GOOGLE_CONNECTOR_CAPABILITIES = [
  "google.basic_identity",
  "google.calendar.read",
  "google.gmail.triage",
  "google.gmail.send",
] as const;
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

export type AgentGoogleCapability =
  | "google.basic_identity"
  | "google.calendar.read"
  | "google.calendar.write"
  | "google.gmail.triage"
  | "google.gmail.send"
  | "google.gmail.manage";

export interface ManagedGoogleConnectorStatus {
  provider: "google";
  side: OAuthConnectionRole;
  mode: "cloud_managed";
  configured: boolean;
  connected: boolean;
  reason: "connected" | "disconnected" | "config_missing" | "token_missing" | "needs_reauth";
  identity: Record<string, unknown> | null;
  grantedCapabilities: AgentGoogleCapability[];
  grantedScopes: string[];
  expiresAt: string | null;
  hasRefreshToken: boolean;
  connectionId: string | null;
  linkedAt: string | null;
  lastUsedAt: string | null;
}

export interface ManagedGoogleCalendarEvent {
  externalId: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  status: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  timezone: string | null;
  htmlLink: string | null;
  conferenceLink: string | null;
  organizer: Record<string, unknown> | null;
  attendees: Array<{
    email: string | null;
    displayName: string | null;
    responseStatus: string | null;
    self: boolean;
    organizer: boolean;
    optional: boolean;
  }>;
  metadata: Record<string, unknown>;
}

export interface ManagedGoogleCalendarSummary {
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
}

export interface ManagedGoogleGmailMessage {
  externalId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isImportant: boolean;
  likelyReplyNeeded: boolean;
  triageScore: number;
  triageReason: string;
  labels: string[];
  htmlLink: string | null;
  metadata: Record<string, unknown>;
}

export interface ManagedGoogleGmailReadResult {
  message: ManagedGoogleGmailMessage;
  bodyText: string;
}

export interface ManagedGoogleGmailSearchResult {
  messages: ManagedGoogleGmailMessage[];
  syncedAt: string;
}

export interface ManagedGoogleGmailSubscriptionHeader {
  messageId: string;
  threadId: string;
  receivedAt: string;
  subject: string;
  fromDisplay: string;
  fromEmail: string | null;
  listId: string | null;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  snippet: string;
  labels: string[];
}

export interface ManagedGoogleGmailSubscriptionHeadersResult {
  headers: ManagedGoogleGmailSubscriptionHeader[];
  syncedAt: string;
}

export class AgentGoogleConnectorError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentGoogleConnectorError";
  }
}

type GoogleConnectionRow = typeof platformCredentials.$inferSelect;

type GoogleCalendarEventDate = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarApiEvent = {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  iCalUID?: string;
  recurringEventId?: string;
  created?: string;
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
  organizer?: {
    email?: string;
    displayName?: string;
    self?: boolean;
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
    optional?: boolean;
  }>;
  conferenceData?: {
    entryPoints?: Array<{
      uri?: string;
    }>;
  };
};

type GoogleCalendarListApiEntry = {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  timeZone?: string;
  selected?: boolean;
  deleted?: boolean;
  hidden?: boolean;
};

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

type ManagedGoogleConnectorDeps = {
  dbRead: {
    select: (...args: unknown[]) => any;
  };
  oauthService: {
    listConnections: typeof oauthService.listConnections;
    getValidToken: typeof oauthService.getValidToken;
    getValidTokenByPlatformWithConnectionId: typeof oauthService.getValidTokenByPlatformWithConnectionId;
    initiateAuth: typeof oauthService.initiateAuth;
    revokeConnection: typeof oauthService.revokeConnection;
  };
};

export const managedGoogleConnectorDeps: ManagedGoogleConnectorDeps = {
  dbRead,
  oauthService,
};

function fail(status: number, message: string): never {
  throw new AgentGoogleConnectorError(status, message);
}

function normalizeCapabilities(
  requested?: readonly AgentGoogleCapability[],
): AgentGoogleCapability[] {
  const source = requested ?? DEFAULT_GOOGLE_CONNECTOR_CAPABILITIES;
  const normalized = [...new Set(source)];
  return normalized.includes("google.basic_identity")
    ? normalized
    : ["google.basic_identity", ...normalized];
}

function capabilitiesToScopes(capabilities: readonly AgentGoogleCapability[]): string[] {
  const scopes = new Set<string>([
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]);

  for (const capability of normalizeCapabilities(capabilities)) {
    if (capability === "google.calendar.read") {
      scopes.add("https://www.googleapis.com/auth/calendar.readonly");
    }
    if (capability === "google.calendar.write") {
      scopes.add("https://www.googleapis.com/auth/calendar.events");
    }
    if (capability === "google.gmail.triage") {
      scopes.add("https://www.googleapis.com/auth/gmail.readonly");
    }
    if (capability === "google.gmail.send") {
      scopes.add("https://www.googleapis.com/auth/gmail.send");
    }
    if (capability === "google.gmail.manage") {
      scopes.add("https://www.googleapis.com/auth/gmail.modify");
      scopes.add("https://www.googleapis.com/auth/gmail.settings.basic");
    }
  }

  return [...scopes];
}

function scopesToCapabilities(scopes: readonly string[]): AgentGoogleCapability[] {
  const granted = new Set(scopes);
  const capabilities: AgentGoogleCapability[] = [];
  const hasIdentity =
    granted.has("openid") ||
    granted.has("email") ||
    granted.has("profile") ||
    granted.has("https://www.googleapis.com/auth/userinfo.email") ||
    granted.has("https://www.googleapis.com/auth/userinfo.profile");
  if (hasIdentity) {
    capabilities.push("google.basic_identity");
  }
  if (
    granted.has("https://www.googleapis.com/auth/calendar.readonly") ||
    granted.has("https://www.googleapis.com/auth/calendar.events") ||
    granted.has("https://www.googleapis.com/auth/calendar")
  ) {
    capabilities.push("google.calendar.read");
  }
  if (
    granted.has("https://www.googleapis.com/auth/calendar.events") ||
    granted.has("https://www.googleapis.com/auth/calendar")
  ) {
    capabilities.push("google.calendar.write");
  }
  if (
    granted.has("https://www.googleapis.com/auth/gmail.metadata") ||
    granted.has("https://www.googleapis.com/auth/gmail.readonly") ||
    granted.has("https://www.googleapis.com/auth/gmail.modify") ||
    granted.has("https://www.googleapis.com/auth/gmail.compose")
  ) {
    capabilities.push("google.gmail.triage");
  }
  if (granted.has("https://www.googleapis.com/auth/gmail.send")) {
    capabilities.push("google.gmail.send");
  }
  if (
    granted.has("https://www.googleapis.com/auth/gmail.modify") &&
    granted.has("https://www.googleapis.com/auth/gmail.settings.basic")
  ) {
    capabilities.push("google.gmail.manage");
  }
  return normalizeCapabilities(capabilities);
}

async function getConnectionRow(
  organizationId: string,
  connectionId: string,
): Promise<GoogleConnectionRow | null> {
  const [row] = await managedGoogleConnectorDeps.dbRead
    .select()
    .from(platformCredentials)
    .where(
      and(
        eq(platformCredentials.organization_id, organizationId),
        eq(platformCredentials.id, connectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getScopedGoogleConnections(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
}) {
  return managedGoogleConnectorDeps.oauthService.listConnections({
    organizationId: args.organizationId,
    userId: args.userId,
    platform: "google",
    connectionRole: args.side,
  });
}

async function getActiveGoogleConnectionRecord(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
}) {
  const connections = await getScopedGoogleConnections(args);
  const activeConnection = getPreferredActiveConnection(connections, args.userId, args.side);
  const latestConnection = connections[0] ?? null;
  const activeRow = activeConnection
    ? await getConnectionRow(args.organizationId, activeConnection.id)
    : null;
  const latestRow =
    latestConnection && latestConnection.id !== activeConnection?.id
      ? await getConnectionRow(args.organizationId, latestConnection.id)
      : activeRow;

  return {
    connections,
    activeConnection,
    latestConnection,
    activeRow,
    latestRow,
  };
}

async function getGoogleAccessToken(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
}): Promise<{ accessToken: string; connectionId: string }> {
  try {
    if (args.grantId) {
      const connection = (
        await getScopedGoogleConnections({
          organizationId: args.organizationId,
          userId: args.userId,
          side: args.side,
        })
      ).find((candidate) => candidate.id === args.grantId);
      if (!connection) {
        fail(404, "Google connection not found.");
      }
      const token = await managedGoogleConnectorDeps.oauthService.getValidToken({
        organizationId: args.organizationId,
        connectionId: connection.id,
        platform: "google",
      });
      return {
        accessToken: token.accessToken,
        connectionId: connection.id,
      };
    }
    return await managedGoogleConnectorDeps.oauthService
      .getValidTokenByPlatformWithConnectionId({
        organizationId: args.organizationId,
        userId: args.userId,
        platform: "google",
        connectionRole: args.side,
      })
      .then((result) => ({
        accessToken: result.token.accessToken,
        connectionId: result.connectionId,
      }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(409, message);
  }
}

async function googleFetch(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  url: string;
  options?: RequestInit;
}): Promise<Response> {
  const { accessToken } = await getGoogleAccessToken(args);
  try {
    return await googleFetchWithToken(accessToken, args.url, args.options);
  } catch (error) {
    fail(502, error instanceof Error ? error.message : String(error));
  }
}

function getZonedDateParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`missing zoned date part: ${type}`);
    }
    return Number(value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const token = parts.find((part) => part.type === "timeZoneName")?.value?.trim() ?? "GMT";
  if (token === "GMT" || token === "UTC") {
    return 0;
  }
  const match = token.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    throw new Error(`unsupported offset token: ${token}`);
  }
  const sign = match[1] === "+" ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

function localPartsToEpochMs(parts: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function buildUtcDateFromLocalParts(
  timeZone: string,
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
): Date {
  const baseUtcMs = localPartsToEpochMs(parts);
  let candidate = new Date(baseUtcMs);
  for (let index = 0; index < 6; index += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(candidate, timeZone);
    const adjusted = new Date(baseUtcMs - offsetMinutes * 60_000);
    const actualParts = getZonedDateParts(adjusted, timeZone);
    const deltaMinutes = Math.round(
      (localPartsToEpochMs(parts) - localPartsToEpochMs(actualParts)) / 60_000,
    );
    if (deltaMinutes === 0) {
      return adjusted;
    }
    candidate = new Date(adjusted.getTime() + deltaMinutes * 60_000);
  }
  return candidate;
}

function normalizeGoogleDateOnly(
  date: string,
  timeZone: string | undefined,
): { iso: string; timeZone: string | null } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const effectiveTimeZone = timeZone?.trim() || "UTC";
  if (!match) {
    return {
      iso: new Date(`${date}T00:00:00.000Z`).toISOString(),
      timeZone: timeZone?.trim() || null,
    };
  }
  const localizedMidnight = buildUtcDateFromLocalParts(effectiveTimeZone, {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  });
  return {
    iso: localizedMidnight.toISOString(),
    timeZone: effectiveTimeZone,
  };
}

function readGoogleEventInstant(
  value: GoogleCalendarEventDate | undefined,
  fallbackTimeZone?: string,
): { iso: string; isAllDay: boolean; timeZone: string | null } | null {
  if (!value) return null;
  if (value.dateTime?.trim()) {
    return {
      iso: new Date(value.dateTime).toISOString(),
      isAllDay: false,
      timeZone: value.timeZone?.trim() || null,
    };
  }
  if (value.date?.trim()) {
    const normalized = normalizeGoogleDateOnly(
      value.date,
      value.timeZone?.trim() || fallbackTimeZone,
    );
    return {
      iso: normalized.iso,
      isAllDay: true,
      timeZone: normalized.timeZone,
    };
  }
  return null;
}

function readConferenceLink(event: GoogleCalendarApiEvent): string | null {
  if (event.hangoutLink?.trim()) {
    return event.hangoutLink.trim();
  }
  return event.conferenceData?.entryPoints?.find((entry) => entry.uri?.trim())?.uri?.trim() || null;
}

function normalizeGoogleCalendarEvent(
  calendarId: string,
  event: GoogleCalendarApiEvent,
  fallbackTimeZone?: string,
): ManagedGoogleCalendarEvent | null {
  const externalId = event.id?.trim();
  const start = readGoogleEventInstant(event.start, fallbackTimeZone);
  const end = readGoogleEventInstant(event.end, start?.timeZone ?? fallbackTimeZone);
  if (!externalId || !start || !end) {
    return null;
  }

  return {
    externalId,
    calendarId,
    title: event.summary?.trim() || "Untitled event",
    description: event.description?.trim() || "",
    location: event.location?.trim() || "",
    status: event.status?.trim() || "confirmed",
    startAt: start.iso,
    endAt: end.iso,
    isAllDay: start.isAllDay,
    timezone: start.timeZone || end.timeZone,
    htmlLink: event.htmlLink?.trim() || null,
    conferenceLink: readConferenceLink(event),
    organizer: event.organizer
      ? {
          email: event.organizer.email?.trim() || null,
          displayName: event.organizer.displayName?.trim() || null,
          self: Boolean(event.organizer.self),
        }
      : null,
    attendees: (event.attendees ?? []).map((attendee) => ({
      email: attendee.email?.trim() || null,
      displayName: attendee.displayName?.trim() || null,
      responseStatus: attendee.responseStatus?.trim() || null,
      self: Boolean(attendee.self),
      organizer: Boolean(attendee.organizer),
      optional: Boolean(attendee.optional),
    })),
    metadata: {
      iCalUID: event.iCalUID?.trim() || null,
      recurringEventId: event.recurringEventId?.trim() || null,
      createdAt: event.created?.trim() || null,
    },
  };
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

function shapeConnectedStatus(
  side: OAuthConnectionRole,
  connection: NonNullable<Awaited<ReturnType<typeof getScopedGoogleConnections>>[number]>,
  row: GoogleConnectionRow | null,
): ManagedGoogleConnectorStatus {
  const connected = connection.status === "active";
  const reason = connected
    ? "connected"
    : connection.status === "expired" || connection.status === "error"
      ? "needs_reauth"
      : "disconnected";

  return {
    provider: "google",
    side,
    mode: "cloud_managed",
    configured: true,
    connected,
    reason,
    identity: {
      id: connection.platformUserId,
      email: connection.email ?? null,
      name: connection.displayName ?? connection.username ?? null,
      avatarUrl: connection.avatarUrl ?? null,
    },
    grantedCapabilities: scopesToCapabilities(connection.scopes),
    grantedScopes: [...connection.scopes],
    expiresAt: row?.token_expires_at?.toISOString() ?? null,
    hasRefreshToken: Boolean(row?.refresh_token_secret_id),
    connectionId: connection.id,
    linkedAt: connection.linkedAt.toISOString(),
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
  };
}

function emptyStatus(side: OAuthConnectionRole, configured: boolean): ManagedGoogleConnectorStatus {
  return {
    provider: "google",
    side,
    mode: "cloud_managed",
    configured,
    connected: false,
    reason: configured ? "disconnected" : "config_missing",
    identity: null,
    grantedCapabilities: [],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: false,
    connectionId: null,
    linkedAt: null,
    lastUsedAt: null,
  };
}

export async function getManagedGoogleConnectorStatus(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
}): Promise<ManagedGoogleConnectorStatus> {
  const provider = getProvider("google");
  const configured = provider ? isProviderConfigured(provider) : false;

  if (!configured) {
    return emptyStatus(args.side, false);
  }

  if (args.grantId) {
    const connection =
      (
        await getScopedGoogleConnections({
          organizationId: args.organizationId,
          userId: args.userId,
          side: args.side,
        })
      ).find((candidate) => candidate.id === args.grantId) ?? null;
    if (!connection) {
      fail(404, "Google connection not found.");
    }
    const row = await getConnectionRow(args.organizationId, connection.id);
    return shapeConnectedStatus(args.side, connection, row);
  }

  const { activeConnection, latestConnection, activeRow, latestRow } =
    await getActiveGoogleConnectionRecord(args);
  const currentConnection = activeConnection ?? latestConnection ?? null;
  const currentRow = activeRow ?? latestRow ?? null;

  if (!currentConnection) {
    return emptyStatus(args.side, true);
  }

  return shapeConnectedStatus(args.side, currentConnection, currentRow);
}

export async function listManagedGoogleConnectorAccounts(args: {
  organizationId: string;
  userId: string;
  side?: OAuthConnectionRole;
}): Promise<ManagedGoogleConnectorStatus[]> {
  const sides: OAuthConnectionRole[] = args.side ? [args.side] : ["owner", "agent"];
  const results: ManagedGoogleConnectorStatus[] = [];

  for (const side of sides) {
    const connections = await getScopedGoogleConnections({
      organizationId: args.organizationId,
      userId: args.userId,
      side,
    });

    for (const connection of connections) {
      const row = await getConnectionRow(args.organizationId, connection.id);
      results.push(shapeConnectedStatus(side, connection, row));
    }
  }

  return results;
}

export async function initiateManagedGoogleConnection(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  redirectUrl?: string;
  capabilities?: AgentGoogleCapability[];
}) {
  const requestedCapabilities = normalizeCapabilities(args.capabilities);
  const auth = await managedGoogleConnectorDeps.oauthService.initiateAuth({
    organizationId: args.organizationId,
    userId: args.userId,
    platform: "google",
    redirectUrl: args.redirectUrl,
    scopes: capabilitiesToScopes(requestedCapabilities),
    connectionRole: args.side,
  });
  return {
    provider: "google" as const,
    side: args.side,
    mode: "cloud_managed" as const,
    requestedCapabilities,
    redirectUri: args.redirectUrl ?? "/auth/success?platform=google",
    authUrl: auth.authUrl,
  };
}

export async function disconnectManagedGoogleConnection(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  connectionId?: string | null;
}): Promise<void> {
  const connections = await getScopedGoogleConnections(args);
  const activeConnection =
    (args.connectionId
      ? connections.find((connection) => connection.id === args.connectionId)
      : getPreferredActiveConnection(connections, args.userId, args.side)) ??
    connections[0] ??
    null;
  if (!activeConnection) {
    return;
  }
  await managedGoogleConnectorDeps.oauthService.revokeConnection({
    organizationId: args.organizationId,
    connectionId: activeConnection.id,
  });
}

export async function fetchManagedGoogleCalendarFeed(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  timeZone: string;
}): Promise<{
  calendarId: string;
  events: ManagedGoogleCalendarEvent[];
  syncedAt: string;
}> {
  const baseParams = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    showDeleted: "false",
    maxResults: "2500",
    timeMin: args.timeMin,
    timeMax: args.timeMax,
    fields:
      "nextPageToken,items(id,status,summary,description,location,htmlLink,hangoutLink,iCalUID,recurringEventId,created,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,organizer,optional),conferenceData(entryPoints(uri)))",
    timeZone: args.timeZone,
  });

  const events: ManagedGoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams(baseParams);
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const response = await googleFetch({
      organizationId: args.organizationId,
      userId: args.userId,
      side: args.side,
      grantId: args.grantId,
      url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events?${params.toString()}`,
    });
    const parsed = (await response.json()) as {
      items?: GoogleCalendarApiEvent[];
      nextPageToken?: string;
    };
    events.push(
      ...(parsed.items ?? [])
        .map((event) => normalizeGoogleCalendarEvent(args.calendarId, event, args.timeZone))
        .filter((event): event is ManagedGoogleCalendarEvent => event !== null),
    );
    pageToken = parsed.nextPageToken?.trim() || undefined;
  } while (pageToken);

  return {
    calendarId: args.calendarId,
    events,
    syncedAt: new Date().toISOString(),
  };
}

export async function listManagedGoogleCalendars(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
}): Promise<ManagedGoogleCalendarSummary[]> {
  const params = new URLSearchParams({
    minAccessRole: "reader",
    showDeleted: "false",
    showHidden: "false",
    fields:
      "items(id,summary,summaryOverride,description,primary,accessRole,backgroundColor,foregroundColor,timeZone,selected,deleted,hidden)",
  });

  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_LIST_ENDPOINT}?${params.toString()}`,
  });
  const parsed = (await response.json()) as {
    items?: GoogleCalendarListApiEntry[];
  };

  const calendars: ManagedGoogleCalendarSummary[] = [];
  for (const item of parsed.items ?? []) {
    if (item.deleted || item.hidden) continue;
    const calendarId = item.id?.trim();
    if (!calendarId) continue;
    calendars.push({
      calendarId,
      summary: item.summaryOverride?.trim() || item.summary?.trim() || calendarId,
      description: item.description?.trim() || null,
      primary: Boolean(item.primary),
      accessRole: item.accessRole?.trim() || "reader",
      backgroundColor: item.backgroundColor?.trim() || null,
      foregroundColor: item.foregroundColor?.trim() || null,
      timeZone: item.timeZone?.trim() || null,
      selected: item.selected !== false,
    });
  }

  return calendars;
}

export async function createManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
}): Promise<{ event: ManagedGoogleCalendarEvent }> {
  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events?conferenceDataVersion=1`,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: args.title,
        description: args.description ?? "",
        location: args.location ?? "",
        start: applyTimeZone(args.startAt, args.timeZone),
        end: applyTimeZone(args.endAt, args.timeZone),
        attendees: args.attendees ?? [],
      }),
    },
  });
  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  const event = normalizeGoogleCalendarEvent(args.calendarId, parsed, args.timeZone);
  if (!event) {
    fail(502, "Google Calendar returned an incomplete event payload.");
  }
  return { event };
}

function normalizeManagedCalendarDateTimeInTimeZone(
  value: string | undefined,
  field: string,
  timeZone: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = value.trim();
  if (!text) {
    fail(400, `${field} is required.`);
  }
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) {
    const parsed = new Date(text);
    if (!Number.isFinite(parsed.getTime())) {
      fail(400, `${field} must be a valid datetime.`);
    }
    return parsed.toISOString();
  }

  const localMatch = text.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/,
  );
  if (localMatch) {
    if (!timeZone) {
      fail(
        400,
        `${field} must include a timezone or UTC offset when no event timezone is available.`,
      );
    }
    const localized = buildUtcDateFromLocalParts(timeZone, {
      year: Number(localMatch[1]),
      month: Number(localMatch[2]),
      day: Number(localMatch[3]),
      hour: Number(localMatch[4] ?? "0"),
      minute: Number(localMatch[5] ?? "0"),
      second: Number(localMatch[6] ?? "0"),
    });
    localized.setUTCMilliseconds(Number((localMatch[7] ?? "0").padEnd(3, "0")));
    return localized.toISOString();
  }

  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    fail(400, `${field} must be a valid datetime.`);
  }
  return parsed.toISOString();
}

async function fetchManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  eventId: string;
  fallbackTimeZone?: string;
}): Promise<ManagedGoogleCalendarEvent | null> {
  const params = new URLSearchParams({
    fields:
      "id,status,summary,description,location,htmlLink,hangoutLink,iCalUID,recurringEventId,created,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,organizer,optional),conferenceData(entryPoints(uri))",
  });
  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}?${params.toString()}`,
  });
  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  return normalizeGoogleCalendarEvent(args.calendarId, parsed, args.fallbackTimeZone);
}

export async function updateManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  eventId: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
    optional?: boolean;
  }>;
}): Promise<{ event: ManagedGoogleCalendarEvent }> {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const needsExistingEventContext =
    Boolean(args.startAt || args.endAt) && (!args.timeZone || !args.startAt || !args.endAt);
  const existingEvent = needsExistingEventContext
    ? await fetchManagedGoogleCalendarEvent({
        organizationId: args.organizationId,
        userId: args.userId,
        side: args.side,
        grantId: args.grantId,
        calendarId: args.calendarId,
        eventId: args.eventId,
        fallbackTimeZone: args.timeZone,
      })
    : null;
  const effectiveTimeZone = args.timeZone ?? existingEvent?.timezone ?? undefined;
  let normalizedStartAt = normalizeManagedCalendarDateTimeInTimeZone(
    args.startAt,
    "startAt",
    effectiveTimeZone,
  );
  let normalizedEndAt = normalizeManagedCalendarDateTimeInTimeZone(
    args.endAt,
    "endAt",
    effectiveTimeZone,
  );
  const existingDurationMs =
    existingEvent &&
    Number.isFinite(Date.parse(existingEvent.startAt)) &&
    Number.isFinite(Date.parse(existingEvent.endAt))
      ? Date.parse(existingEvent.endAt) - Date.parse(existingEvent.startAt)
      : Number.NaN;
  const fallbackDurationMs =
    Number.isFinite(existingDurationMs) && existingDurationMs > 0
      ? existingDurationMs
      : ONE_HOUR_MS;
  if (normalizedStartAt && !normalizedEndAt) {
    normalizedEndAt = new Date(
      new Date(normalizedStartAt).getTime() + fallbackDurationMs,
    ).toISOString();
  } else if (normalizedEndAt && !normalizedStartAt) {
    normalizedStartAt = new Date(
      new Date(normalizedEndAt).getTime() - fallbackDurationMs,
    ).toISOString();
  }

  const response = await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}?conferenceDataVersion=1`,
    options: {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(args.title !== undefined ? { summary: args.title } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.location !== undefined ? { location: args.location } : {}),
        ...(normalizedStartAt
          ? { start: applyTimeZone(normalizedStartAt, effectiveTimeZone) }
          : {}),
        ...(normalizedEndAt ? { end: applyTimeZone(normalizedEndAt, effectiveTimeZone) } : {}),
        ...(args.attendees !== undefined ? { attendees: args.attendees } : {}),
      }),
    },
  });
  const parsed = (await response.json()) as GoogleCalendarApiEvent;
  const event = normalizeGoogleCalendarEvent(args.calendarId, parsed, effectiveTimeZone);
  if (!event) {
    fail(502, "Google Calendar returned an incomplete event payload.");
  }
  return { event };
}

export async function deleteManagedGoogleCalendarEvent(args: {
  organizationId: string;
  userId: string;
  side: OAuthConnectionRole;
  grantId?: string;
  calendarId: string;
  eventId: string;
}): Promise<{ ok: true }> {
  await googleFetch({
    organizationId: args.organizationId,
    userId: args.userId,
    side: args.side,
    grantId: args.grantId,
    url: `${GOOGLE_CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(args.calendarId)}/events/${encodeURIComponent(args.eventId)}`,
    options: {
      method: "DELETE",
    },
  });
  return { ok: true };
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

function hasGmailBodyReadScope(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return (
    granted.has("https://www.googleapis.com/auth/gmail.readonly") ||
    granted.has("https://www.googleapis.com/auth/gmail.modify") ||
    granted.has("https://mail.google.com/")
  );
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
    fail(502, "Google Gmail returned an incomplete message payload.");
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
