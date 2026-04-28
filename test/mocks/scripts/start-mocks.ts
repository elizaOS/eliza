import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GITHUB_FIXTURE_NOTIFICATIONS,
  GITHUB_FIXTURE_PULLS,
  GITHUB_FIXTURE_SEARCH_ITEMS,
} from "../helpers/github-octokit-fixture.ts";
import type { GoogleCalendarRequestLedgerMetadata } from "./google-calendar-state.ts";
import {
  createGoogleMockState,
  type GmailRequestLedgerMetadata,
  type GoogleMockState,
  googleDynamicFixture,
} from "./google-gmail-state.ts";
import { MockHttpError } from "./mock-http-error.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENVS_DIR = path.resolve(__dirname, "..", "environments");

export const MOCK_ENVIRONMENTS = [
  "google",
  "twilio",
  "whatsapp",
  "x-twitter",
  "calendly",
  "cloud-managed",
  "signal",
  "browser-workspace",
  "bluebubbles",
  "github",
] as const;

export type MockEnvironmentName = (typeof MOCK_ENVIRONMENTS)[number];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RequestBody = Record<string, JsonValue>;

interface MockoonHeader {
  key: string;
  value: string;
}

interface MockoonResponse {
  statusCode?: number;
  headers?: MockoonHeader[];
  body?: string;
}

interface MockoonRoute {
  method: string;
  endpoint: string;
  responses?: MockoonResponse[];
}

interface MockoonEnvironmentFile {
  name?: string;
  routes?: MockoonRoute[];
}

interface CompiledRoute {
  method: string;
  endpoint: string;
  response: MockoonResponse;
  matcher: RegExp;
  paramNames: string[];
}

interface StartedFixtureServer {
  port: number;
  baseUrl: string;
  requests: MockRequestLedgerEntry[];
  clearRequests(): void;
  stop(): Promise<void>;
}

export interface MockRequestLedgerEntry {
  environment: string;
  method: string;
  path: string;
  query: string;
  body: RequestBody;
  createdAt: string;
  runId?: string;
  gmail?: GmailRequestLedgerMetadata;
  calendar?: GoogleCalendarRequestLedgerMetadata;
  x?: XRequestLedgerMetadata;
  whatsapp?: WhatsAppRequestLedgerMetadata;
  signal?: SignalRequestLedgerMetadata;
  browserWorkspace?: BrowserWorkspaceRequestLedgerMetadata;
  bluebubbles?: BlueBubblesRequestLedgerMetadata;
  github?: GitHubRequestLedgerMetadata;
}

interface XRequestLedgerMetadata {
  action: string;
  userId?: string;
  query?: string;
  tweetId?: string;
  conversationId?: string;
  dmEventId?: string;
  limit?: number;
  runId?: string;
}

interface WhatsAppRequestLedgerMetadata {
  action: string;
  phoneNumberId?: string;
  recipient?: string;
  messageId?: string;
  ingested?: number;
  runId?: string;
}

interface SignalRequestLedgerMetadata {
  action: string;
  account?: string;
  recipients?: string[];
  groupId?: string;
  timestamp?: number;
  runId?: string;
}

interface BrowserWorkspaceRequestLedgerMetadata {
  action: string;
  tabId?: string;
  partition?: string;
  url?: string;
  runId?: string;
}

interface BlueBubblesRequestLedgerMetadata {
  action: string;
  chatGuid?: string;
  messageGuid?: string;
  query?: string;
  runId?: string;
}

interface GitHubRequestLedgerMetadata {
  action: string;
  owner?: string;
  repo?: string;
  number?: number;
  query?: string;
  runId?: string;
}

export interface StartedMocks {
  portMap: Record<MockEnvironmentName, number>;
  baseUrls: Record<MockEnvironmentName, string>;
  /** Convenience env vars to set on process.env */
  envVars: Record<string, string>;
  requestLedger(): MockRequestLedgerEntry[];
  clearRequestLedger(): void;
  stop(): Promise<void>;
}

function envVarsFor(
  envs: readonly MockEnvironmentName[],
  baseUrls: Record<MockEnvironmentName, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (envs.includes("google")) {
    out.ELIZA_MOCK_GOOGLE_BASE = baseUrls.google;
    out.ELIZA_BLOCK_REAL_GMAIL_WRITES = "1";
  }
  if (envs.includes("twilio")) out.ELIZA_MOCK_TWILIO_BASE = baseUrls.twilio;
  if (envs.includes("whatsapp"))
    out.ELIZA_MOCK_WHATSAPP_BASE = baseUrls.whatsapp;
  if (envs.includes("x-twitter"))
    out.ELIZA_MOCK_X_BASE = baseUrls["x-twitter"];
  if (envs.includes("calendly"))
    out.ELIZA_MOCK_CALENDLY_BASE = baseUrls.calendly;
  if (envs.includes("cloud-managed"))
    out.ELIZA_CLOUD_BASE_URL = baseUrls["cloud-managed"];
  if (envs.includes("signal")) {
    out.SIGNAL_HTTP_URL = baseUrls.signal;
    out.SIGNAL_ACCOUNT_NUMBER = "+15550000000";
  }
  if (envs.includes("browser-workspace")) {
    out.ELIZA_BROWSER_WORKSPACE_URL = baseUrls["browser-workspace"];
    out.ELIZA_BROWSER_WORKSPACE_TOKEN = "mock-browser-workspace-token";
  }
  if (envs.includes("bluebubbles")) {
    out.ELIZA_IMESSAGE_BACKEND = "bluebubbles";
    out.ELIZA_BLUEBUBBLES_URL = baseUrls.bluebubbles;
    out.BLUEBUBBLES_SERVER_URL = baseUrls.bluebubbles;
    out.ELIZA_BLUEBUBBLES_PASSWORD = "mock-bluebubbles-password";
    out.BLUEBUBBLES_PASSWORD = "mock-bluebubbles-password";
  }
  if (envs.includes("github")) {
    out.ELIZA_MOCK_GITHUB_BASE = baseUrls.github;
    out.GITHUB_API_URL = baseUrls.github;
  }
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileEndpoint(endpoint: string): {
  matcher: RegExp;
  paramNames: string[];
} {
  const paramNames: string[] = [];
  const segments = endpoint
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return escapeRegex(segment);
    });

  return {
    matcher: new RegExp(`^/${segments.join("/")}/?$`),
    paramNames,
  };
}

function compileRoutes(environment: MockoonEnvironmentFile): CompiledRoute[] {
  return (environment.routes ?? []).map((route) => {
    const { matcher, paramNames } = compileEndpoint(route.endpoint);
    const response = route.responses?.find((candidate) => candidate) ?? {};

    return {
      method: route.method.toUpperCase(),
      endpoint: route.endpoint,
      response,
      matcher,
      paramNames,
    };
  });
}

function readEnvironment(dataPath: string): MockoonEnvironmentFile {
  const parsed = JSON.parse(fs.readFileSync(dataPath, "utf8")) as JsonValue;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid mock environment JSON: ${dataPath}`);
  }

  const environment = parsed as Partial<MockoonEnvironmentFile>;
  if (!Array.isArray(environment.routes)) {
    throw new Error(`Mock environment has no routes array: ${dataPath}`);
  }

  return {
    name: typeof environment.name === "string" ? environment.name : dataPath,
    routes: environment.routes.filter(
      (route): route is MockoonRoute =>
        !!route &&
        typeof route === "object" &&
        !Array.isArray(route) &&
        typeof route.method === "string" &&
        typeof route.endpoint === "string",
    ),
  };
}

async function readRequestBody(
  req: http.IncomingMessage,
): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};

  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }

  if (contentType.includes("application/json")) {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw) as JsonValue;
    } catch {
      throw new MockHttpError(400, "Invalid JSON body");
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  }

  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function valueAsTemplateString(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function escapeTemplateString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function randomFromAlphabet(alphabet: string, length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}

function fakerValue(kind: string, lengthText?: string): string {
  if (kind === "string.uuid") return crypto.randomUUID();

  const length = Number.parseInt(lengthText ?? "", 10);
  const size = Number.isFinite(length) && length > 0 ? length : 16;
  if (kind === "string.numeric") return randomFromAlphabet("0123456789", size);
  if (kind === "string.alphanumeric") {
    return randomFromAlphabet(
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      size,
    );
  }

  return crypto.randomUUID();
}

function offsetDate(offsetText?: string): Date {
  const date = new Date();
  const match = offsetText?.match(/^([+-])(\d+)([hm])$/);
  if (!match) return date;

  const sign = match[1] === "-" ? -1 : 1;
  const amount = Number.parseInt(match[2], 10);
  const unitMs = match[3] === "h" ? 60 * 60 * 1000 : 60 * 1000;
  return new Date(date.getTime() + sign * amount * unitMs);
}

function formatHttpDate(date: Date): string {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${weekdays[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${
    months[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )}:${pad(date.getUTCSeconds())} GMT`;
}

function nowValue(format: string, offsetText?: string): string {
  const date = offsetDate(offsetText);
  if (format === "x") return String(date.getTime());
  if (format === "iso") return date.toISOString();
  if (format === "ddd, DD MMM YYYY HH:mm:ss [GMT]") {
    return formatHttpDate(date);
  }
  return date.toISOString();
}

function renderBodyTemplate(
  body: string,
  params: Record<string, string>,
  requestBody: RequestBody,
): string {
  return body
    .replace(/\{\{urlParam '([^']+)'\}\}/g, (_, key: string) =>
      escapeTemplateString(params[key] ?? ""),
    )
    .replace(/\{\{body '([^']+)'\}\}/g, (_, key: string) =>
      escapeTemplateString(valueAsTemplateString(requestBody[key])),
    )
    .replace(
      /\{\{faker '([^']+)'(?: length=(\d+))?\}\}/g,
      (_, kind: string, length: string | undefined) => fakerValue(kind, length),
    )
    .replace(
      /\{\{now '([^']+)'(?: offset='([^']+)')?\}\}/g,
      (_, format: string, offset: string | undefined) =>
        nowValue(format, offset),
    );
}

function findRoute(
  routes: readonly CompiledRoute[],
  method: string,
  pathname: string,
): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;

    const match = route.matcher.exec(pathname);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? "");
    });

    return { route, params };
  }

  return null;
}

function headerValue(
  headers: http.IncomingHttpHeaders,
  key: string,
): string | null {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function requestRunId(headers: http.IncomingHttpHeaders): string | undefined {
  return (
    headerValue(headers, "x-eliza-test-run") ??
    headerValue(headers, "x-eliza-run-id") ??
    headerValue(headers, "x-test-run-id") ??
    undefined
  );
}

interface DynamicFixtureResponse {
  statusCode: number;
  body: JsonValue;
  headers?: Record<string, string>;
}

function jsonFixture(
  body: JsonValue | object,
  statusCode = 200,
): DynamicFixtureResponse {
  return {
    statusCode,
    body: body as JsonValue,
    headers: { "Content-Type": "application/json" },
  };
}

function mockJsonError(
  statusCode: number,
  message: string,
): DynamicFixtureResponse {
  return jsonFixture({ error: message }, statusCode);
}

function routeParam(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

function readOptionalString(body: RequestBody, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readRequiredFixtureString(body: RequestBody, key: string): string {
  const value = readOptionalString(body, key);
  if (!value) throw new MockHttpError(400, `${key} must be a non-empty string`);
  return value;
}

function readStringArray(body: RequestBody, key: string): string[] {
  const value = body[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function numericSearchParam(
  searchParams: URLSearchParams,
  key: string,
  fallback: number,
): number {
  const parsed = Number.parseInt(searchParams.get(key) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withRunId<T extends { runId?: string }>(
  ledgerEntry: MockRequestLedgerEntry,
  metadata: Omit<T, "runId">,
): T {
  return {
    ...(metadata as T),
    ...(ledgerEntry.runId ? { runId: ledgerEntry.runId } : {}),
  };
}

type XUser = { id: string; username: string };
type XTweet = {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  conversation_id: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
};
type XDmEvent = {
  id: string;
  event_type: "MessageCreate";
  text: string;
  sender_id: string;
  dm_conversation_id: string;
  created_at: string;
};

interface XMockState {
  users: XUser[];
  homeTweets: XTweet[];
  mentionTweets: XTweet[];
  searchTweets: XTweet[];
  dmEvents: XDmEvent[];
}

function createXMockState(): XMockState {
  const createdAt = "2026-04-25T18:30:00.000Z";
  return {
    users: [
      { id: "user-owner", username: "mocked_owner" },
      { id: "user-alice", username: "alice_ops" },
      { id: "user-bob", username: "bob_builder" },
    ],
    homeTweets: [
      {
        id: "tweet-home-1",
        text: "Eliza central mocks are ready for connector smoke tests.",
        author_id: "user-alice",
        created_at: createdAt,
        conversation_id: "tweet-home-1",
      },
      {
        id: "tweet-home-2",
        text: "elizaOS agents should read DTOs instead of recomputing.",
        author_id: "user-bob",
        created_at: "2026-04-25T17:45:00.000Z",
        conversation_id: "tweet-home-2",
      },
    ],
    mentionTweets: [
      {
        id: "tweet-mention-1",
        text: "@mocked_owner can you review the LifeOps provider fixture?",
        author_id: "user-alice",
        created_at: "2026-04-25T16:00:00.000Z",
        conversation_id: "tweet-mention-1",
        referenced_tweets: [{ type: "replied_to", id: "tweet-home-1" }],
      },
    ],
    searchTweets: [
      {
        id: "tweet-search-1",
        text: "Testing elizaOS X search through a deterministic mock.",
        author_id: "user-bob",
        created_at: "2026-04-25T15:00:00.000Z",
        conversation_id: "tweet-search-1",
      },
      {
        id: "tweet-search-2",
        text: "Eliza LifeOps search fixtures cover pagination metadata.",
        author_id: "user-alice",
        created_at: "2026-04-25T14:00:00.000Z",
        conversation_id: "tweet-search-2",
      },
    ],
    dmEvents: [
      {
        id: "dm-event-1",
        event_type: "MessageCreate",
        text: "Can you check the connector fixture today?",
        sender_id: "user-alice",
        dm_conversation_id: "dm-user-owner-user-alice",
        created_at: "2026-04-25T13:00:00.000Z",
      },
      {
        id: "dm-event-2",
        event_type: "MessageCreate",
        text: "I replied from the owner account.",
        sender_id: "user-owner",
        dm_conversation_id: "dm-user-owner-user-alice",
        created_at: "2026-04-25T13:05:00.000Z",
      },
    ],
  };
}

function xPageResponse<T extends JsonValue>(
  data: T[],
  users: readonly XUser[],
  limit: number,
): DynamicFixtureResponse {
  const page = data.slice(0, Math.max(1, limit));
  return jsonFixture({
    data: page,
    includes: { users: [...users] },
    meta: {
      result_count: page.length,
      ...(data.length > page.length ? { next_token: "mock-next-page" } : {}),
    },
  });
}

function xDynamicFixture(
  state: XMockState,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  requestBody: RequestBody,
  ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method === "GET" && pathname === "/2/dm_events") {
    const limit = numericSearchParam(searchParams, "max_results", 25);
    ledgerEntry.x = withRunId<XRequestLedgerMetadata>(ledgerEntry, {
      action: "dm_events.list",
      limit,
    });
    return xPageResponse(state.dmEvents, state.users, limit);
  }

  const homeUserId = routeParam(
    pathname,
    /^\/2\/users\/([^/]+)\/timelines\/reverse_chronological\/?$/,
  );
  if (method === "GET" && homeUserId) {
    const limit = numericSearchParam(searchParams, "max_results", 25);
    ledgerEntry.x = withRunId<XRequestLedgerMetadata>(ledgerEntry, {
      action: "timelines.reverse_chronological",
      userId: homeUserId,
      limit,
    });
    return xPageResponse(state.homeTweets, state.users, limit);
  }

  const mentionsUserId = routeParam(
    pathname,
    /^\/2\/users\/([^/]+)\/mentions\/?$/,
  );
  if (method === "GET" && mentionsUserId) {
    const limit = numericSearchParam(searchParams, "max_results", 25);
    ledgerEntry.x = withRunId<XRequestLedgerMetadata>(ledgerEntry, {
      action: "users.mentions",
      userId: mentionsUserId,
      limit,
    });
    return xPageResponse(state.mentionTweets, state.users, limit);
  }

  if (method === "GET" && pathname === "/2/tweets/search/recent") {
    const query = searchParams.get("query")?.trim();
    if (!query) return mockJsonError(400, "query is required");
    const limit = numericSearchParam(searchParams, "max_results", 25);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = state.searchTweets.filter((tweet) =>
      tokens.some((token) => tweet.text.toLowerCase().includes(token)),
    );
    ledgerEntry.x = withRunId<XRequestLedgerMetadata>(ledgerEntry, {
      action: "tweets.search_recent",
      query,
      limit,
    });
    return xPageResponse(
      matches.length > 0 ? matches : state.searchTweets,
      state.users,
      limit,
    );
  }

  if (method === "POST" && pathname === "/2/tweets") {
    const text = readRequiredFixtureString(requestBody, "text");
    const tweet: XTweet = {
      id: `tweet-${randomFromAlphabet("0123456789", 18)}`,
      text,
      author_id: "user-owner",
      created_at: new Date().toISOString(),
      conversation_id: `tweet-${randomFromAlphabet("0123456789", 18)}`,
    };
    state.homeTweets.unshift(tweet);
    ledgerEntry.x = withRunId<XRequestLedgerMetadata>(ledgerEntry, {
      action: "tweets.create",
      tweetId: tweet.id,
    });
    return jsonFixture({ data: { id: tweet.id, text: tweet.text } });
  }

  const dmRecipientId = routeParam(
    pathname,
    /^\/2\/dm_conversations\/with\/([^/]+)\/messages\/?$/,
  );
  if (method === "POST" && dmRecipientId) {
    const text = readRequiredFixtureString(requestBody, "text");
    const event: XDmEvent = {
      id: `dm-event-${randomFromAlphabet("0123456789", 18)}`,
      event_type: "MessageCreate",
      text,
      sender_id: "user-owner",
      dm_conversation_id: `dm-user-owner-${dmRecipientId}`,
      created_at: new Date().toISOString(),
    };
    state.dmEvents.unshift(event);
    ledgerEntry.x = withRunId<XRequestLedgerMetadata>(ledgerEntry, {
      action: "dm_conversations.messages.create",
      conversationId: event.dm_conversation_id,
      dmEventId: event.id,
    });
    return jsonFixture({
      data: {
        dm_event_id: event.id,
        dm_conversation_id: event.dm_conversation_id,
      },
    });
  }

  return null;
}

interface WhatsAppInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
}

function whatsappInboundMessageToJson(
  message: WhatsAppInboundMessage,
): JsonValue {
  return {
    id: message.id,
    from: message.from,
    timestamp: message.timestamp,
    type: message.type,
    ...(message.text ? { text: { ...message.text } } : {}),
  };
}

interface WhatsAppMockState {
  inboundMessages: WhatsAppInboundMessage[];
}

function createWhatsAppMockState(): WhatsAppMockState {
  return { inboundMessages: [] };
}

function readNestedRecord(
  value: JsonValue | undefined,
): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function parseWhatsAppWebhookMessages(
  payload: RequestBody,
): WhatsAppInboundMessage[] {
  const entries = payload.entry;
  if (!Array.isArray(entries)) return [];
  const messages: WhatsAppInboundMessage[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const changes = entry.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== "object" || Array.isArray(change)) {
        continue;
      }
      const value = readNestedRecord(change.value);
      const rawMessages = value?.messages;
      if (!Array.isArray(rawMessages)) continue;
      for (const rawMessage of rawMessages) {
        if (
          !rawMessage ||
          typeof rawMessage !== "object" ||
          Array.isArray(rawMessage)
        ) {
          continue;
        }
        if (
          typeof rawMessage.id !== "string" ||
          typeof rawMessage.from !== "string"
        ) {
          continue;
        }
        const text = readNestedRecord(rawMessage.text);
        messages.push({
          id: rawMessage.id,
          from: rawMessage.from,
          timestamp:
            typeof rawMessage.timestamp === "string"
              ? rawMessage.timestamp
              : String(Math.floor(Date.now() / 1000)),
          type:
            typeof rawMessage.type === "string" ? rawMessage.type : "unknown",
          ...(text && typeof text.body === "string"
            ? { text: { body: text.body } }
            : {}),
        });
      }
    }
  }
  return messages;
}

function whatsappDynamicFixture(
  state: WhatsAppMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  const phoneNumberId = routeParam(
    pathname,
    /^\/v[^/]+\/([^/]+)\/messages\/?$/,
  );
  if (method === "POST" && phoneNumberId) {
    const recipient = readRequiredFixtureString(requestBody, "to");
    const messageId = `wamid.${randomFromAlphabet(
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      20,
    )}`;
    ledgerEntry.whatsapp = withRunId<WhatsAppRequestLedgerMetadata>(
      ledgerEntry,
      {
        action: "messages.send",
        phoneNumberId,
        recipient,
        messageId,
      },
    );
    return jsonFixture({
      messaging_product: "whatsapp",
      contacts: [{ input: recipient, wa_id: recipient }],
      messages: [{ id: messageId }],
    });
  }

  if (
    method === "POST" &&
    (pathname === "/webhook" || pathname === "/webhooks/whatsapp")
  ) {
    const messages = parseWhatsAppWebhookMessages(requestBody);
    for (const message of messages) {
      const existingIndex = state.inboundMessages.findIndex(
        (candidate) => candidate.id === message.id,
      );
      if (existingIndex >= 0) {
        state.inboundMessages[existingIndex] = message;
      } else {
        state.inboundMessages.push(message);
      }
    }
    ledgerEntry.whatsapp = withRunId<WhatsAppRequestLedgerMetadata>(
      ledgerEntry,
      { action: "webhook.ingest", ingested: messages.length },
    );
    return jsonFixture({
      ok: true,
      ingested: messages.length,
      messages: messages.map(whatsappInboundMessageToJson),
    });
  }

  if (pathname === "/__mock/whatsapp/inbound") {
    ledgerEntry.whatsapp = withRunId<WhatsAppRequestLedgerMetadata>(
      ledgerEntry,
      { action: "webhook.buffer" },
    );
    if (method === "GET") {
      return jsonFixture({
        messages: state.inboundMessages.map(whatsappInboundMessageToJson),
      });
    }
    if (method === "DELETE") {
      const drained = state.inboundMessages.splice(
        0,
        state.inboundMessages.length,
      );
      return jsonFixture({
        drained: drained.length,
        messages: drained.map(whatsappInboundMessageToJson),
      });
    }
  }

  return null;
}

interface SignalEnvelopeMessage {
  envelope: {
    source: string;
    sourceNumber: string;
    sourceName: string;
    timestamp: number;
    dataMessage: {
      timestamp: number;
      message: string;
      groupInfo?: { groupId: string; type: string };
    };
  };
  account: string;
}

function signalEnvelopeMessageToJson(
  message: SignalEnvelopeMessage,
): JsonValue {
  return {
    account: message.account,
    envelope: {
      source: message.envelope.source,
      sourceNumber: message.envelope.sourceNumber,
      sourceName: message.envelope.sourceName,
      timestamp: message.envelope.timestamp,
      dataMessage: {
        timestamp: message.envelope.dataMessage.timestamp,
        message: message.envelope.dataMessage.message,
        ...(message.envelope.dataMessage.groupInfo
          ? { groupInfo: { ...message.envelope.dataMessage.groupInfo } }
          : {}),
      },
    },
  };
}

interface SignalMockState {
  receiveQueue: SignalEnvelopeMessage[];
}

function createSignalMockState(): SignalMockState {
  const now = Date.parse("2026-04-25T12:00:00.000Z");
  return {
    receiveQueue: [
      {
        envelope: {
          source: "+15551110001",
          sourceNumber: "+15551110001",
          sourceName: "Alice Signal",
          timestamp: now,
          dataMessage: {
            timestamp: now,
            message: "Signal fixture inbound message",
          },
        },
        account: "+15550000000",
      },
      {
        envelope: {
          source: "+15551110002",
          sourceNumber: "+15551110002",
          sourceName: "Ops Group",
          timestamp: now + 1_000,
          dataMessage: {
            timestamp: now + 1_000,
            message: "Signal group fixture message",
            groupInfo: { groupId: "group-signal-fixture", type: "DELIVER" },
          },
        },
        account: "+15550000000",
      },
    ],
  };
}

function signalRpcResponse(
  requestBody: RequestBody,
  result: JsonValue,
): DynamicFixtureResponse {
  return jsonFixture({
    jsonrpc: "2.0",
    id: requestBody.id ?? null,
    result,
  });
}

function signalDynamicFixture(
  state: SignalMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method === "GET" && pathname === "/api/v1/check") {
    ledgerEntry.signal = withRunId<SignalRequestLedgerMetadata>(ledgerEntry, {
      action: "check",
    });
    return jsonFixture({ ok: true });
  }

  if (method === "POST" && pathname === "/api/v1/rpc") {
    const rpcMethod = readRequiredFixtureString(requestBody, "method");
    const params = readNestedRecord(requestBody.params) ?? {};
    const account =
      typeof params.account === "string" ? params.account : "+15550000000";
    ledgerEntry.signal = withRunId<SignalRequestLedgerMetadata>(ledgerEntry, {
      action: `rpc.${rpcMethod}`,
      account,
      recipients: Array.isArray(params.recipients)
        ? params.recipients.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : undefined,
      groupId: typeof params.groupId === "string" ? params.groupId : undefined,
      timestamp: Date.now(),
    });
    if (rpcMethod === "version")
      return signalRpcResponse(requestBody, "mock-signal-cli");
    if (rpcMethod === "listAccounts") {
      return signalRpcResponse(requestBody, [
        { number: "+15550000000", uuid: "mock-signal-account" },
      ]);
    }
    if (rpcMethod === "listContacts") {
      return signalRpcResponse(requestBody, [
        {
          number: "+15551110001",
          uuid: "mock-contact-alice",
          name: "Alice Signal",
        },
      ]);
    }
    if (rpcMethod === "listGroups") {
      return signalRpcResponse(requestBody, [
        {
          id: "group-signal-fixture",
          name: "Ops Group",
          isMember: true,
          isBlocked: false,
          members: [{ uuid: "mock-contact-alice", number: "+15551110001" }],
        },
      ]);
    }
    if (rpcMethod === "send") {
      return signalRpcResponse(requestBody, { timestamp: Date.now() });
    }
    return signalRpcResponse(requestBody, {});
  }

  const receiveAccount = routeParam(pathname, /^\/v1\/receive\/([^/]+)\/?$/);
  if (method === "GET" && receiveAccount) {
    const messages = state.receiveQueue.splice(0, state.receiveQueue.length);
    ledgerEntry.signal = withRunId<SignalRequestLedgerMetadata>(ledgerEntry, {
      action: "receive",
      account: receiveAccount,
    });
    return jsonFixture(messages.map(signalEnvelopeMessageToJson));
  }

  if (method === "POST" && pathname === "/v2/send") {
    const recipients = readStringArray(requestBody, "recipients");
    const timestamp = Date.now();
    ledgerEntry.signal = withRunId<SignalRequestLedgerMetadata>(ledgerEntry, {
      action: "send",
      account: readOptionalString(requestBody, "number") ?? undefined,
      recipients,
      timestamp,
    });
    return jsonFixture({ timestamp });
  }

  return null;
}

const MOCK_SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+R4QAAAAASUVORK5CYII=";

interface BrowserWorkspaceTab {
  id: string;
  url: string;
  partition: string;
  title?: string;
  kind?: string;
  show?: boolean;
}

interface BrowserWorkspaceMockState {
  tabs: Map<string, BrowserWorkspaceTab>;
  nextTabId: number;
}

function createBrowserWorkspaceMockState(): BrowserWorkspaceMockState {
  return { tabs: new Map(), nextTabId: 1 };
}

function requireBearerToken(
  headers: http.IncomingHttpHeaders,
  token: string,
): DynamicFixtureResponse | null {
  const authorization = headerValue(headers, "authorization");
  return authorization === `Bearer ${token}`
    ? null
    : mockJsonError(401, "unauthorized");
}

function browserWorkspaceEvalResult(
  script: string,
  tab: BrowserWorkspaceTab,
): JsonValue {
  if (script.includes("searchMessages")) {
    return { injected: true };
  }
  if (
    script.includes("searchResultMessage") ||
    script.includes("search-result-message")
  ) {
    return [
      {
        id: "123456789012345678",
        content: "the quick brown fox from Discord",
        authorName: "alice",
        channelId: "222",
        timestamp: "2026-04-25T12:00:00.000Z",
        deliveryStatus: "unknown",
      },
    ];
  }
  if (script.includes("deliveryStatus")) {
    return [
      {
        id: "223456789012345678",
        content: "sent through Discord fixture",
        authorName: null,
        channelId: "222",
        timestamp: "2026-04-25T12:05:00.000Z",
        deliveryStatus: "sent",
      },
    ];
  }
  if (
    script.includes("probeDiscordDocumentState") ||
    script.includes("DISCORD_DM_PREVIEW_LIMIT")
  ) {
    return {
      loggedIn: true,
      url: tab.url,
      identity: { id: null, username: "mocked_owner", discriminator: "0001" },
      rawSnippet: "mocked_owner | Direct messages",
      dmInbox: {
        visible: true,
        count: 2,
        selectedChannelId: "222",
        previews: [
          {
            channelId: "111",
            href: "/channels/@me/111",
            label: "Alice",
            selected: false,
            unread: true,
            snippet: "Are we meeting tomorrow?",
          },
          {
            channelId: "222",
            href: "/channels/@me/222",
            label: "Bob",
            selected: true,
            unread: false,
            snippet: "Sent you the file",
          },
        ],
      },
    };
  }
  return { ok: true };
}

function browserWorkspaceDynamicFixture(
  state: BrowserWorkspaceMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  headers: http.IncomingHttpHeaders,
  ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  const authFailure = requireBearerToken(
    headers,
    "mock-browser-workspace-token",
  );
  if (authFailure) return authFailure;

  if (method === "GET" && pathname === "/tabs") {
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.list",
      });
    return jsonFixture({ tabs: [...state.tabs.values()] });
  }

  if (method === "POST" && pathname === "/tabs") {
    const id = `tab_${state.nextTabId++}`;
    const url = readOptionalString(requestBody, "url") ?? "about:blank";
    const partition = readOptionalString(requestBody, "partition") ?? "";
    const title = readOptionalString(requestBody, "title") ?? undefined;
    const kind = readOptionalString(requestBody, "kind") ?? undefined;
    const show = requestBody.show === true;
    const tab: BrowserWorkspaceTab = {
      id,
      url,
      partition,
      ...(title ? { title } : {}),
      ...(kind ? { kind } : {}),
      show,
    };
    state.tabs.set(id, tab);
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.create",
        tabId: id,
        partition,
        url,
      });
    return jsonFixture({ tab });
  }

  const tabMatch =
    /^\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?\/?$/.exec(
      pathname,
    );
  if (!tabMatch) return null;

  const tabId = decodeURIComponent(tabMatch[1] ?? "");
  const action = tabMatch[2] ?? null;
  const tab = state.tabs.get(tabId);

  if (!action && method === "DELETE") {
    const closed = state.tabs.delete(tabId);
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.close",
        tabId,
      });
    return closed
      ? jsonFixture({ closed: true })
      : mockJsonError(404, "tab not found");
  }

  if (!tab) return mockJsonError(404, "tab not found");

  if (action === "show" && method === "POST") {
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.show",
        tabId,
      });
    return jsonFixture({ tab: { ...tab, show: true } });
  }

  if (action === "hide" && method === "POST") {
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.hide",
        tabId,
      });
    return jsonFixture({ tab: { ...tab, show: false } });
  }

  if (action === "navigate" && method === "POST") {
    const url = readRequiredFixtureString(requestBody, "url");
    const nextTab = { ...tab, url };
    state.tabs.set(tabId, nextTab);
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.navigate",
        tabId,
        url,
      });
    return jsonFixture({ tab: nextTab });
  }

  if (action === "eval" && method === "POST") {
    const script = readOptionalString(requestBody, "script") ?? "";
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.eval",
        tabId,
      });
    return jsonFixture({ result: browserWorkspaceEvalResult(script, tab) });
  }

  if (action === "snapshot" && method === "GET") {
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.snapshot",
        tabId,
      });
    return jsonFixture({ data: MOCK_SCREENSHOT_BASE64 });
  }

  return mockJsonError(405, "method not allowed");
}

interface BlueBubblesChatFixture {
  guid: string;
  displayName: string;
  chatIdentifier: string;
  participants: Array<{ address: string }>;
  lastMessageAt: number;
}

interface BlueBubblesMessageFixture {
  guid: string;
  text: string;
  handle: { address: string } | null;
  chatGuid: string;
  chats: Array<{ guid: string }>;
  isFromMe: boolean;
  dateCreated: number;
  isRead?: boolean;
  isDelivered?: boolean;
  error?: number | null;
  errorDescription?: string | null;
}

interface BlueBubblesMockState {
  chats: BlueBubblesChatFixture[];
  messages: BlueBubblesMessageFixture[];
}

function createBlueBubblesMockState(): BlueBubblesMockState {
  const chatGuid = "iMessage;-;+15551112222";
  return {
    chats: [
      {
        guid: chatGuid,
        displayName: "Alice iMessage",
        chatIdentifier: "+15551112222",
        participants: [{ address: "+15551112222" }],
        lastMessageAt: Date.parse("2026-04-25T12:00:00.000Z"),
      },
    ],
    messages: [
      {
        guid: "imsg-fixture-1",
        text: "Can you review the BlueBubbles fixture?",
        handle: { address: "+15551112222" },
        chatGuid,
        chats: [{ guid: chatGuid }],
        isFromMe: false,
        dateCreated: Date.parse("2026-04-25T12:00:00.000Z"),
        isRead: true,
        isDelivered: true,
      },
    ],
  };
}

function bluebubblesResponse(data: JsonValue | object): DynamicFixtureResponse {
  return jsonFixture({ status: 200, data });
}

function bluebubblesDynamicFixture(
  state: BlueBubblesMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  headers: http.IncomingHttpHeaders,
  ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  const authFailure = requireBearerToken(headers, "mock-bluebubbles-password");
  if (authFailure) return authFailure;

  if (method === "GET" && pathname === "/api/v1/server/info") {
    ledgerEntry.bluebubbles = withRunId<BlueBubblesRequestLedgerMetadata>(
      ledgerEntry,
      {
        action: "server.info",
      },
    );
    return bluebubblesResponse({
      private_api: true,
      helper_connected: true,
      detected_imessage: "owner@example.test",
      detected_icloud: "owner@icloud.test",
    });
  }

  if (method === "POST" && pathname === "/api/v1/chat/query") {
    ledgerEntry.bluebubbles = withRunId<BlueBubblesRequestLedgerMetadata>(
      ledgerEntry,
      {
        action: "chat.query",
      },
    );
    return bluebubblesResponse(state.chats);
  }

  if (method === "POST" && pathname === "/api/v1/message/query") {
    const search = readOptionalString(requestBody, "search");
    const chatGuid = readOptionalString(requestBody, "chatGuid");
    const messages = state.messages.filter((message) => {
      if (chatGuid && message.chatGuid !== chatGuid) return false;
      if (
        search &&
        !message.text.toLowerCase().includes(search.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
    ledgerEntry.bluebubbles = withRunId<BlueBubblesRequestLedgerMetadata>(
      ledgerEntry,
      {
        action: search ? "message.search" : "message.query",
        ...(chatGuid ? { chatGuid } : {}),
        ...(search ? { query: search } : {}),
      },
    );
    return bluebubblesResponse(messages);
  }

  const chatMessageId = routeParam(
    pathname,
    /^\/api\/v1\/chat\/([^/]+)\/message\/?$/,
  );
  if (method === "GET" && chatMessageId) {
    const messages = state.messages.filter(
      (message) => message.chatGuid === chatMessageId,
    );
    ledgerEntry.bluebubbles = withRunId<BlueBubblesRequestLedgerMetadata>(
      ledgerEntry,
      {
        action: "chat.messages",
        chatGuid: chatMessageId,
      },
    );
    return bluebubblesResponse(messages);
  }

  if (method === "POST" && pathname === "/api/v1/message/text") {
    const chatGuid = readRequiredFixtureString(requestBody, "chatGuid");
    const text = readRequiredFixtureString(requestBody, "message");
    const message: BlueBubblesMessageFixture = {
      guid: `imsg-${randomFromAlphabet("0123456789abcdef", 12)}`,
      text,
      handle: null,
      chatGuid,
      chats: [{ guid: chatGuid }],
      isFromMe: true,
      dateCreated: Date.now(),
      isRead: false,
      isDelivered: true,
    };
    state.messages.unshift(message);
    ledgerEntry.bluebubbles = withRunId<BlueBubblesRequestLedgerMetadata>(
      ledgerEntry,
      {
        action: "message.text",
        chatGuid,
        messageGuid: message.guid,
      },
    );
    return bluebubblesResponse(message);
  }

  const messageGuid = routeParam(pathname, /^\/api\/v1\/message\/([^/]+)\/?$/);
  if (method === "GET" && messageGuid) {
    const message = state.messages.find(
      (candidate) => candidate.guid === messageGuid,
    );
    ledgerEntry.bluebubbles = withRunId<BlueBubblesRequestLedgerMetadata>(
      ledgerEntry,
      {
        action: "message.get",
        messageGuid,
      },
    );
    return message
      ? bluebubblesResponse(message)
      : mockJsonError(404, "message not found");
  }

  return null;
}

interface GitHubMockState {
  nextIssueNumber: number;
  nextReviewId: number;
}

function createGitHubMockState(): GitHubMockState {
  return { nextIssueNumber: 101, nextReviewId: 777 };
}

function parseGitHubRepoPath(
  pathname: string,
  suffix: RegExp,
): { owner: string; repo: string; match: RegExpExecArray } | null {
  const match = suffix.exec(pathname);
  if (!match) return null;
  return {
    owner: decodeURIComponent(match[1] ?? ""),
    repo: decodeURIComponent(match[2] ?? ""),
    match,
  };
}

function githubDynamicFixture(
  state: GitHubMockState,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  requestBody: RequestBody,
  ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  const pullsPath = parseGitHubRepoPath(
    pathname,
    /^\/repos\/([^/]+)\/([^/]+)\/pulls\/?$/,
  );
  if (method === "GET" && pullsPath) {
    const requestedState = searchParams.get("state") ?? "open";
    const pulls = GITHUB_FIXTURE_PULLS.filter(
      (pull) => requestedState === "all" || pull.state === requestedState,
    );
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "pulls.list",
      owner: pullsPath.owner,
      repo: pullsPath.repo,
    });
    return jsonFixture(pulls);
  }

  const reviewPath = parseGitHubRepoPath(
    pathname,
    /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews\/?$/,
  );
  if (method === "POST" && reviewPath) {
    const number = Number.parseInt(reviewPath.match[3] ?? "", 10);
    const id = state.nextReviewId++;
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "pulls.createReview",
      owner: reviewPath.owner,
      repo: reviewPath.repo,
      number,
    });
    return jsonFixture({ id });
  }

  const createIssuePath = parseGitHubRepoPath(
    pathname,
    /^\/repos\/([^/]+)\/([^/]+)\/issues\/?$/,
  );
  if (method === "POST" && createIssuePath) {
    const number = state.nextIssueNumber++;
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "issues.create",
      owner: createIssuePath.owner,
      repo: createIssuePath.repo,
      number,
    });
    return jsonFixture({
      number,
      html_url: `https://github.com/${createIssuePath.owner}/${createIssuePath.repo}/issues/${number}`,
      title: readOptionalString(requestBody, "title") ?? "Mock issue",
    });
  }

  const assigneesPath = parseGitHubRepoPath(
    pathname,
    /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/assignees\/?$/,
  );
  if (method === "POST" && assigneesPath) {
    const number = Number.parseInt(assigneesPath.match[3] ?? "", 10);
    const assignees = readStringArray(requestBody, "assignees").map(
      (login) => ({ login }),
    );
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "issues.addAssignees",
      owner: assigneesPath.owner,
      repo: assigneesPath.repo,
      number,
    });
    return jsonFixture({ assignees });
  }

  if (method === "GET" && pathname === "/search/issues") {
    const query = searchParams.get("q") ?? "";
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "search.issuesAndPullRequests",
      query,
    });
    return jsonFixture({
      total_count: GITHUB_FIXTURE_SEARCH_ITEMS.length,
      incomplete_results: false,
      items: GITHUB_FIXTURE_SEARCH_ITEMS,
    });
  }

  if (method === "GET" && pathname === "/notifications") {
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "activity.listNotificationsForAuthenticatedUser",
    });
    return jsonFixture(GITHUB_FIXTURE_NOTIFICATIONS);
  }

  return null;
}

type DynamicProviderState =
  | { kind: "google"; state: GoogleMockState }
  | { kind: "x-twitter"; state: XMockState }
  | { kind: "whatsapp"; state: WhatsAppMockState }
  | { kind: "signal"; state: SignalMockState }
  | { kind: "browser-workspace"; state: BrowserWorkspaceMockState }
  | { kind: "bluebubbles"; state: BlueBubblesMockState }
  | { kind: "github"; state: GitHubMockState }
  | null;

function createDynamicProviderState(
  environmentName: string | undefined,
): DynamicProviderState {
  if (environmentName === "Google APIs") {
    return { kind: "google", state: createGoogleMockState() };
  }
  if (environmentName === "X (Twitter)") {
    return { kind: "x-twitter", state: createXMockState() };
  }
  if (environmentName === "WhatsApp") {
    return { kind: "whatsapp", state: createWhatsAppMockState() };
  }
  if (environmentName === "Signal HTTP") {
    return { kind: "signal", state: createSignalMockState() };
  }
  if (environmentName === "Browser Workspace") {
    return {
      kind: "browser-workspace",
      state: createBrowserWorkspaceMockState(),
    };
  }
  if (environmentName === "BlueBubbles") {
    return { kind: "bluebubbles", state: createBlueBubblesMockState() };
  }
  if (environmentName === "GitHub REST") {
    return { kind: "github", state: createGitHubMockState() };
  }
  return null;
}

function dynamicProviderFixture(args: {
  provider: DynamicProviderState;
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  requestBody: RequestBody;
  headers: http.IncomingHttpHeaders;
  ledgerEntry: MockRequestLedgerEntry;
}): DynamicFixtureResponse | null {
  if (!args.provider) return null;
  switch (args.provider.kind) {
    case "google":
      return googleDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.searchParams,
        args.requestBody,
        args.headers,
        args.ledgerEntry,
      );
    case "x-twitter":
      return xDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.searchParams,
        args.requestBody,
        args.ledgerEntry,
      );
    case "whatsapp":
      return whatsappDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "signal":
      return signalDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "browser-workspace":
      return browserWorkspaceDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.headers,
        args.ledgerEntry,
      );
    case "bluebubbles":
      return bluebubblesDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.headers,
        args.ledgerEntry,
      );
    case "github":
      return githubDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.searchParams,
        args.requestBody,
        args.ledgerEntry,
      );
  }
}

async function startFixtureServer(
  dataPath: string,
): Promise<StartedFixtureServer> {
  const environment = readEnvironment(dataPath);
  const routes = compileRoutes(environment);
  const requests: MockRequestLedgerEntry[] = [];
  const dynamicProvider = createDynamicProviderState(environment.name);
  let stopped = false;

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = (req.method ?? "GET").toUpperCase();
      const requestBody = await readRequestBody(req);
      if (method === "GET" && requestUrl.pathname === "/__mock/requests") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ requests }));
        return;
      }
      if (method === "DELETE" && requestUrl.pathname === "/__mock/requests") {
        requests.splice(0, requests.length);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const ledgerEntry: MockRequestLedgerEntry = {
        environment: environment.name ?? dataPath,
        method,
        path: requestUrl.pathname,
        query: requestUrl.search,
        body: requestBody,
        createdAt: new Date().toISOString(),
        ...(requestRunId(req.headers)
          ? { runId: requestRunId(req.headers) }
          : {}),
      };
      requests.push(ledgerEntry);
      const dynamicResponse = dynamicProviderFixture({
        provider: dynamicProvider,
        method,
        pathname: requestUrl.pathname,
        searchParams: requestUrl.searchParams,
        requestBody,
        headers: req.headers,
        ledgerEntry,
      });
      if (dynamicResponse) {
        res.writeHead(dynamicResponse.statusCode, {
          "Content-Type": "application/json",
          ...(dynamicResponse.headers ?? {}),
        });
        res.end(JSON.stringify(dynamicResponse.body));
        return;
      }

      const matched = findRoute(routes, method, requestUrl.pathname);
      if (!matched) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const response = matched.route.response;
      const headers = Object.fromEntries(
        (response.headers ?? []).map((header) => [header.key, header.value]),
      );
      if (!headers["Content-Type"] && !headers["content-type"]) {
        headers["Content-Type"] = "application/json";
      }

      res.writeHead(response.statusCode ?? 200, headers);
      res.end(
        renderBodyTemplate(response.body ?? "", matched.params, requestBody),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = err instanceof MockHttpError ? err.statusCode : 500;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: statusCode === 500 ? "fixture_error" : "bad_request",
          message,
        }),
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  server.unref();

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error(`Failed to bind mock fixture server: ${dataPath}`);
  }

  const port = (address as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    clearRequests: () => {
      requests.splice(0, requests.length);
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export async function startMocks(opts?: {
  envs?: readonly MockEnvironmentName[];
}): Promise<StartedMocks> {
  const envs = opts?.envs ?? MOCK_ENVIRONMENTS;

  const dataPaths = envs.map((e) => path.resolve(ENVS_DIR, `${e}.json`));
  const missing = dataPaths.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    throw new Error(`Mock environment files missing: ${missing.join(", ")}`);
  }

  const servers: StartedFixtureServer[] = [];
  try {
    for (const dataPath of dataPaths) {
      servers.push(await startFixtureServer(dataPath));
    }
  } catch (err) {
    await Promise.allSettled(servers.map((server) => server.stop()));
    throw err;
  }
  const portMap = Object.fromEntries(
    envs.map((e, i) => [e, servers[i].port]),
  ) as Record<MockEnvironmentName, number>;
  const baseUrls = Object.fromEntries(
    envs.map((e, i) => [e, servers[i].baseUrl]),
  ) as Record<MockEnvironmentName, string>;

  return {
    portMap,
    baseUrls,
    envVars: envVarsFor(envs, baseUrls),
    requestLedger: () =>
      servers.flatMap((server) =>
        server.requests.map((entry) => ({ ...entry })),
      ),
    clearRequestLedger: () => {
      for (const server of servers) {
        server.clearRequests();
      }
    },
    stop: async () => {
      await Promise.all(servers.map((server) => server.stop()));
    },
  };
}
