import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findLifeOpsPresenceActiveScenario,
  LIFEOPS_PRESENCE_ACTIVE_FIXTURE_CATALOG,
  lifeOpsPresenceActiveScenarioSummaries,
  lifeOpsPresenceActiveTaskSnapshots,
} from "../fixtures/lifeops-presence-active.ts";
import {
  getLifeOpsSimulatorPerson,
  LIFEOPS_SIMULATOR_CHANNEL_MESSAGES,
  LIFEOPS_SIMULATOR_OWNER,
  LIFEOPS_SIMULATOR_OWNER_IDENTITIES,
  type LifeOpsSimulatorChannelMessage,
  lifeOpsSimulatorMessageTime,
  lifeOpsSimulatorSummary,
} from "../fixtures/lifeops-simulator.ts";
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
const MOCK_BROWSER_WORKSPACE_TOKEN = "mock-browser-workspace-token";
const MOCK_BLUEBUBBLES_PASSWORD = "mock-bluebubbles-password";

export const MOCK_PROVIDER_ENVIRONMENTS = [
  "google",
  "twilio",
  "whatsapp",
  "x-twitter",
  "calendly",
  "cloud-managed",
  "signal",
  "browser-workspace",
  "bluebubbles",
  "imessage",
  "github",
  "discord",
  "slack",
  "telegram",
  "linear",
  "shopify",
  "payments",
  "anthropic",
  "openai",
  "vision",
] as const;

export const MOCK_SCENARIO_ENVIRONMENTS = [
  "lifeops-presence-active",
  "lifeops-presence",
] as const;

export const MOCK_ENVIRONMENTS = [
  ...MOCK_PROVIDER_ENVIRONMENTS,
  ...MOCK_SCENARIO_ENVIRONMENTS,
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

interface MockFixtureOptions {
  simulator?: boolean;
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
  payment?: PaymentRequestLedgerMetadata;
  lifeopsPresenceActive?: LifeOpsPresenceActiveRequestLedgerMetadata;
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

interface PaymentRequestLedgerMetadata {
  action: string;
  paymentRequestId?: string;
  status?: string;
  amountUsd?: number;
  callbackDelivered?: boolean;
  runId?: string;
}

interface LifeOpsPresenceActiveRequestLedgerMetadata {
  action: string;
  scenarioId?: string;
  taskId?: string;
  status?: string;
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
  if (envs.includes("twilio")) {
    out.ELIZA_MOCK_TWILIO_BASE = baseUrls.twilio;
  }
  if (envs.includes("whatsapp"))
    out.ELIZA_MOCK_WHATSAPP_BASE = baseUrls.whatsapp;
  if (envs.includes("x-twitter")) {
    out.ELIZA_MOCK_X_BASE = baseUrls["x-twitter"];
  }
  if (envs.includes("calendly"))
    out.ELIZA_MOCK_CALENDLY_BASE = baseUrls.calendly;
  if (envs.includes("cloud-managed"))
    out.ELIZA_CLOUD_BASE_URL = baseUrls["cloud-managed"];
  if (envs.includes("signal")) {
    out.SIGNAL_HTTP_URL = baseUrls.signal;
    out.SIGNAL_ACCOUNT_NUMBER = LIFEOPS_SIMULATOR_OWNER.phone;
  }
  if (envs.includes("browser-workspace")) {
    out.ELIZA_BROWSER_WORKSPACE_URL = baseUrls["browser-workspace"];
    out.ELIZA_BROWSER_WORKSPACE_TOKEN = MOCK_BROWSER_WORKSPACE_TOKEN;
    out.ELIZA_DISABLE_DISCORD_DESKTOP_CDP = "1";
  }
  if (envs.includes("bluebubbles")) {
    out.ELIZA_IMESSAGE_BACKEND = "bluebubbles";
    out.ELIZA_BLUEBUBBLES_URL = baseUrls.bluebubbles;
    out.BLUEBUBBLES_SERVER_URL = baseUrls.bluebubbles;
    out.ELIZA_BLUEBUBBLES_PASSWORD = MOCK_BLUEBUBBLES_PASSWORD;
    out.BLUEBUBBLES_PASSWORD = MOCK_BLUEBUBBLES_PASSWORD;
  }
  if (envs.includes("imessage")) {
    out.ELIZA_IMESSAGE_BACKEND = "bluebubbles";
    out.ELIZA_BLUEBUBBLES_URL = baseUrls.imessage;
    out.BLUEBUBBLES_SERVER_URL = baseUrls.imessage;
    out.ELIZA_BLUEBUBBLES_PASSWORD = MOCK_BLUEBUBBLES_PASSWORD;
    out.BLUEBUBBLES_PASSWORD = MOCK_BLUEBUBBLES_PASSWORD;
  }
  if (envs.includes("github")) {
    out.ELIZA_MOCK_GITHUB_BASE = baseUrls.github;
    out.GITHUB_API_URL = baseUrls.github;
  }
  if (envs.includes("discord")) {
    out.ELIZA_MOCK_DISCORD_BASE = baseUrls.discord;
  }
  if (envs.includes("slack")) {
    out.ELIZA_MOCK_SLACK_BASE = baseUrls.slack;
  }
  if (envs.includes("telegram")) {
    out.ELIZA_MOCK_TELEGRAM_BASE = baseUrls.telegram;
  }
  if (envs.includes("linear")) {
    out.ELIZA_MOCK_LINEAR_BASE = baseUrls.linear;
  }
  if (envs.includes("shopify")) {
    out.ELIZA_MOCK_SHOPIFY_BASE = baseUrls.shopify;
  }
  if (envs.includes("payments")) {
    out.ELIZA_MOCK_PAYMENT_BASE = baseUrls.payments;
    out.ELIZA_MOCK_PAYMENTS_BASE = baseUrls.payments;
  }
  if (envs.includes("anthropic")) {
    out.ELIZA_MOCK_ANTHROPIC_BASE = baseUrls.anthropic;
  }
  if (envs.includes("openai")) {
    out.ELIZA_MOCK_OPENAI_BASE = baseUrls.openai;
  }
  if (envs.includes("vision")) {
    out.ELIZA_MOCK_VISION_BASE = baseUrls.vision;
  }
  if (envs.includes("lifeops-presence-active")) {
    out.ELIZA_MOCK_LIFEOPS_PRESENCE_ACTIVE_BASE =
      baseUrls["lifeops-presence-active"];
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
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[crypto.randomInt(alphabet.length)];
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

function simulatorWhatsAppMessage(
  message: LifeOpsSimulatorChannelMessage,
): WhatsAppInboundMessage {
  const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
  return {
    id: message.id,
    from: person.whatsappNumber,
    timestamp: String(
      Math.floor(
        Date.parse(lifeOpsSimulatorMessageTime(message.sentAtOffsetMs)) / 1000,
      ),
    ),
    type: "text",
    text: { body: message.text },
  };
}

function createWhatsAppMockState(opts?: MockFixtureOptions): WhatsAppMockState {
  return {
    inboundMessages: opts?.simulator
      ? LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
          (message) => message.channel === "whatsapp",
        ).map(simulatorWhatsAppMessage)
      : [],
  };
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

function simulatorSignalMessage(
  message: LifeOpsSimulatorChannelMessage,
): SignalEnvelopeMessage {
  const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
  const timestamp = Date.parse(
    lifeOpsSimulatorMessageTime(message.sentAtOffsetMs),
  );
  const isGroup = message.threadType === "group";
  return {
    envelope: {
      source: person.signalNumber,
      sourceNumber: person.signalNumber,
      sourceName: isGroup ? message.threadName : `${person.name} Signal`,
      timestamp,
      dataMessage: {
        timestamp,
        message: message.text,
        ...(isGroup
          ? { groupInfo: { groupId: message.threadId, type: "DELIVER" } }
          : {}),
      },
    },
    account: LIFEOPS_SIMULATOR_OWNER.phone,
  };
}

function createSignalMockState(opts?: MockFixtureOptions): SignalMockState {
  const now = Date.parse("2026-04-25T12:00:00.000Z");
  return {
    receiveQueue: opts?.simulator
      ? LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
          (message) => message.channel === "signal",
        ).map(simulatorSignalMessage)
      : [
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
            account: LIFEOPS_SIMULATOR_OWNER.phone,
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
            account: LIFEOPS_SIMULATOR_OWNER.phone,
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
      typeof params.account === "string"
        ? params.account
        : LIFEOPS_SIMULATOR_OWNER.phone;
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
        {
          number: LIFEOPS_SIMULATOR_OWNER.phone,
          uuid: LIFEOPS_SIMULATOR_OWNER_IDENTITIES.signal.uuid,
        },
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
  simulator: boolean;
}

function createBrowserWorkspaceMockState(
  opts?: MockFixtureOptions,
): BrowserWorkspaceMockState {
  return { tabs: new Map(), nextTabId: 1, simulator: Boolean(opts?.simulator) };
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

function simulatorDiscordMessages(): LifeOpsSimulatorChannelMessage[] {
  return LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
    (message) => message.channel === "discord",
  );
}

function browserWorkspaceEvalResult(
  script: string,
  tab: BrowserWorkspaceTab,
  state: BrowserWorkspaceMockState,
): JsonValue {
  if (script.includes("searchMessages")) {
    return { injected: true };
  }
  if (
    script.includes("searchResultMessage") ||
    script.includes("search-result-message")
  ) {
    if (state.simulator) {
      return simulatorDiscordMessages().map((message) => {
        const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
        return {
          id: message.id,
          content: message.text,
          authorName: person.discordUsername,
          channelId: message.threadId,
          timestamp: lifeOpsSimulatorMessageTime(message.sentAtOffsetMs),
          deliveryStatus: "unknown",
        };
      });
    }
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
    const previews = state.simulator
      ? simulatorDiscordMessages().map((message, index) => {
          const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
          return {
            channelId: message.threadId,
            href:
              message.threadType === "dm"
                ? `/channels/@me/${message.threadId}`
                : `/channels/atlas/${message.threadId}`,
            label:
              message.threadType === "dm" ? person.name : message.threadName,
            selected: index === 0,
            unread: message.unread === true,
            snippet: message.text,
          };
        })
      : null;
    return {
      loggedIn: true,
      url: tab.url,
      identity: {
        id: LIFEOPS_SIMULATOR_OWNER_IDENTITIES.discord.id,
        username: LIFEOPS_SIMULATOR_OWNER_IDENTITIES.discord.username,
        discriminator: LIFEOPS_SIMULATOR_OWNER_IDENTITIES.discord.discriminator,
      },
      rawSnippet: `${LIFEOPS_SIMULATOR_OWNER_IDENTITIES.discord.username} | Direct messages`,
      dmInbox: {
        visible: true,
        count: previews?.length ?? 2,
        selectedChannelId: previews?.[0]?.channelId ?? "222",
        previews: previews ?? [
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
  const authFailure = requireBearerToken(headers, MOCK_BROWSER_WORKSPACE_TOKEN);
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
    const nextTab = { ...tab, show: true };
    state.tabs.set(tabId, nextTab);
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.show",
        tabId,
      });
    return jsonFixture({ tab: nextTab });
  }

  if (action === "hide" && method === "POST") {
    const nextTab = { ...tab, show: false };
    state.tabs.set(tabId, nextTab);
    ledgerEntry.browserWorkspace =
      withRunId<BrowserWorkspaceRequestLedgerMetadata>(ledgerEntry, {
        action: "tabs.hide",
        tabId,
      });
    return jsonFixture({ tab: nextTab });
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
    return jsonFixture({
      result: browserWorkspaceEvalResult(script, tab, state),
    });
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

function simulatorBlueBubblesChat(
  message: LifeOpsSimulatorChannelMessage,
): BlueBubblesChatFixture {
  const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
  return {
    guid: message.threadId,
    displayName: message.threadName,
    chatIdentifier: person.phone,
    participants: [{ address: person.phone }],
    lastMessageAt: Date.parse(
      lifeOpsSimulatorMessageTime(message.sentAtOffsetMs),
    ),
  };
}

function simulatorBlueBubblesMessage(
  message: LifeOpsSimulatorChannelMessage,
): BlueBubblesMessageFixture {
  const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
  return {
    guid: message.id,
    text: message.text,
    handle: { address: person.phone },
    chatGuid: message.threadId,
    chats: [{ guid: message.threadId }],
    isFromMe: message.outgoing === true,
    dateCreated: Date.parse(
      lifeOpsSimulatorMessageTime(message.sentAtOffsetMs),
    ),
    isRead: message.unread !== true,
    isDelivered: true,
  };
}

function createBlueBubblesMockState(
  opts?: MockFixtureOptions,
): BlueBubblesMockState {
  if (opts?.simulator) {
    const messages = LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
      (message) => message.channel === "imessage",
    );
    return {
      chats: messages.map(simulatorBlueBubblesChat),
      messages: messages.map(simulatorBlueBubblesMessage),
    };
  }
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
  const authFailure = requireBearerToken(headers, MOCK_BLUEBUBBLES_PASSWORD);
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
      detected_imessage: LIFEOPS_SIMULATOR_OWNER.email,
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

interface GitHubIssueFixture {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  user: { login: string };
  assignees: Array<{ login: string }>;
  body?: string;
}

interface GitHubReviewFixture {
  id: number;
  body: string;
  event: string;
  state: string;
  user: { login: string };
  submitted_at: string;
  pull_request_url: string;
}

interface GitHubMockState {
  nextIssueNumber: number;
  nextReviewId: number;
  issuesByRepo: Map<string, GitHubIssueFixture[]>;
  reviewsByPull: Map<string, GitHubReviewFixture[]>;
}

function createGitHubMockState(): GitHubMockState {
  return {
    nextIssueNumber: 101,
    nextReviewId: 777,
    issuesByRepo: new Map(),
    reviewsByPull: new Map(),
  };
}

function githubRepoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function githubPullKey(owner: string, repo: string, number: number): string {
  return `${githubRepoKey(owner, repo)}#${number}`;
}

function cloneGitHubIssue(issue: GitHubIssueFixture): GitHubIssueFixture {
  return {
    ...issue,
    user: { ...issue.user },
    assignees: issue.assignees.map((assignee) => ({ ...assignee })),
  };
}

function cloneGitHubReview(review: GitHubReviewFixture): GitHubReviewFixture {
  return {
    ...review,
    user: { ...review.user },
  };
}

function findGitHubIssue(
  state: GitHubMockState,
  owner: string,
  repo: string,
  number: number,
): GitHubIssueFixture | null {
  const issues = state.issuesByRepo.get(githubRepoKey(owner, repo)) ?? [];
  return issues.find((issue) => issue.number === number) ?? null;
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
    const event = readOptionalString(requestBody, "event") ?? "COMMENT";
    const review: GitHubReviewFixture = {
      id,
      body: readOptionalString(requestBody, "body") ?? "",
      event,
      state: event === "APPROVE" ? "APPROVED" : event,
      user: { login: "mocked-reviewer" },
      submitted_at: new Date().toISOString(),
      pull_request_url: `https://api.github.com/repos/${reviewPath.owner}/${reviewPath.repo}/pulls/${number}`,
    };
    const key = githubPullKey(reviewPath.owner, reviewPath.repo, number);
    state.reviewsByPull.set(key, [
      review,
      ...(state.reviewsByPull.get(key) ?? []),
    ]);
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "pulls.createReview",
      owner: reviewPath.owner,
      repo: reviewPath.repo,
      number,
    });
    return jsonFixture(cloneGitHubReview(review));
  }

  if (method === "GET" && reviewPath) {
    const number = Number.parseInt(reviewPath.match[3] ?? "", 10);
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "pulls.listReviews",
      owner: reviewPath.owner,
      repo: reviewPath.repo,
      number,
    });
    return jsonFixture(
      (
        state.reviewsByPull.get(
          githubPullKey(reviewPath.owner, reviewPath.repo, number),
        ) ?? []
      ).map(cloneGitHubReview),
    );
  }

  const createIssuePath = parseGitHubRepoPath(
    pathname,
    /^\/repos\/([^/]+)\/([^/]+)\/issues\/?$/,
  );
  if (method === "POST" && createIssuePath) {
    const number = state.nextIssueNumber++;
    const issue: GitHubIssueFixture = {
      number,
      html_url: `https://github.com/${createIssuePath.owner}/${createIssuePath.repo}/issues/${number}`,
      title: readOptionalString(requestBody, "title") ?? "Mock issue",
      state: "open",
      user: { login: "mocked-owner" },
      assignees: [],
      ...(readOptionalString(requestBody, "body")
        ? { body: readOptionalString(requestBody, "body") ?? undefined }
        : {}),
    };
    const key = githubRepoKey(createIssuePath.owner, createIssuePath.repo);
    state.issuesByRepo.set(key, [
      issue,
      ...(state.issuesByRepo.get(key) ?? []),
    ]);
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "issues.create",
      owner: createIssuePath.owner,
      repo: createIssuePath.repo,
      number,
    });
    return jsonFixture(cloneGitHubIssue(issue));
  }

  if (method === "GET" && createIssuePath) {
    const requestedState = searchParams.get("state") ?? "open";
    const issues =
      state.issuesByRepo.get(
        githubRepoKey(createIssuePath.owner, createIssuePath.repo),
      ) ?? [];
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "issues.list",
      owner: createIssuePath.owner,
      repo: createIssuePath.repo,
    });
    return jsonFixture(
      issues
        .filter(
          (issue) => requestedState === "all" || issue.state === requestedState,
        )
        .map(cloneGitHubIssue),
    );
  }

  const issuePath = parseGitHubRepoPath(
    pathname,
    /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/,
  );
  if (method === "GET" && issuePath) {
    const number = Number.parseInt(issuePath.match[3] ?? "", 10);
    const issue = findGitHubIssue(
      state,
      issuePath.owner,
      issuePath.repo,
      number,
    );
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "issues.get",
      owner: issuePath.owner,
      repo: issuePath.repo,
      number,
    });
    return issue
      ? jsonFixture(cloneGitHubIssue(issue))
      : mockJsonError(404, "issue not found");
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
    const issue = findGitHubIssue(
      state,
      assigneesPath.owner,
      assigneesPath.repo,
      number,
    );
    if (issue) {
      const existing = new Set(issue.assignees.map((entry) => entry.login));
      for (const assignee of assignees) {
        if (!existing.has(assignee.login)) issue.assignees.push(assignee);
      }
    }
    ledgerEntry.github = withRunId<GitHubRequestLedgerMetadata>(ledgerEntry, {
      action: "issues.addAssignees",
      owner: assigneesPath.owner,
      repo: assigneesPath.repo,
      number,
    });
    return jsonFixture({
      assignees: issue
        ? issue.assignees.map((entry) => ({ ...entry }))
        : assignees,
    });
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

// ---------------------------------------------------------------------------
// Discord stateful mock
// ---------------------------------------------------------------------------

interface DiscordMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string; bot: boolean };
  content: string;
  timestamp: string;
}

interface DiscordInboundMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string };
  content: string;
  timestamp: string;
}

interface DiscordMockState {
  sentMessages: Map<string, DiscordMessage[]>;
  inboundMessages: Map<string, DiscordInboundMessage[]>;
}

function createDiscordMockState(): DiscordMockState {
  return { sentMessages: new Map(), inboundMessages: new Map() };
}

function discordDynamicFixture(
  state: DiscordMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  const postMsgChannelId = routeParam(
    pathname,
    /^\/api\/v10\/channels\/([^/]+)\/messages\/?$/,
  );

  if (method === "POST" && postMsgChannelId) {
    const content =
      typeof requestBody.content === "string" ? requestBody.content : "";
    const msg: DiscordMessage = {
      id: randomFromAlphabet("0123456789", 18),
      channel_id: postMsgChannelId,
      author: { id: "111111111111111111", username: "mock-bot", bot: true },
      content,
      timestamp: new Date().toISOString(),
    };
    const existing = state.sentMessages.get(postMsgChannelId) ?? [];
    existing.push(msg);
    state.sentMessages.set(postMsgChannelId, existing);
    return jsonFixture(msg);
  }

  if (method === "GET" && postMsgChannelId) {
    const history = [
      ...(state.inboundMessages.get(postMsgChannelId) ?? []),
      ...(state.sentMessages.get(postMsgChannelId) ?? []),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return jsonFixture(history);
  }

  if (pathname === "/__mock/discord/sent") {
    if (method === "GET") {
      const all: DiscordMessage[] = [];
      for (const msgs of state.sentMessages.values()) all.push(...msgs);
      return jsonFixture({ messages: all });
    }
    if (method === "DELETE") {
      state.sentMessages.clear();
      return jsonFixture({ ok: true });
    }
  }

  if (pathname === "/__mock/discord/inbound" && method === "POST") {
    const channelId =
      typeof requestBody.channel_id === "string"
        ? requestBody.channel_id
        : "000000000000000000";
    const content =
      typeof requestBody.content === "string" ? requestBody.content : "inbound";
    const authorId =
      typeof requestBody.author_id === "string"
        ? requestBody.author_id
        : "444444444444444444";
    const authorName =
      typeof requestBody.author_name === "string"
        ? requestBody.author_name
        : "mock-user";
    const msg: DiscordInboundMessage = {
      id: randomFromAlphabet("0123456789", 18),
      channel_id: channelId,
      author: { id: authorId, username: authorName },
      content,
      timestamp: new Date().toISOString(),
    };
    const existing = state.inboundMessages.get(channelId) ?? [];
    existing.push(msg);
    state.inboundMessages.set(channelId, existing);
    return jsonFixture({ ok: true, message: msg });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Slack stateful mock
// ---------------------------------------------------------------------------

interface SlackMessage {
  type: "message";
  ts: string;
  user: string;
  text: string;
  channel: string;
}

interface SlackMockState {
  sentMessages: Map<string, SlackMessage[]>;
  inboundMessages: Map<string, SlackMessage[]>;
}

function createSlackMockState(): SlackMockState {
  return { sentMessages: new Map(), inboundMessages: new Map() };
}

function slackTs(): string {
  return `${Math.floor(Date.now() / 1000)}.${String(
    Math.floor(Math.random() * 1_000_000),
  ).padStart(6, "0")}`;
}

function slackDynamicFixture(
  state: SlackMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method === "POST" && pathname === "/api/chat.postMessage") {
    const channel =
      typeof requestBody.channel === "string" ? requestBody.channel : "C00MOCK";
    const text = typeof requestBody.text === "string" ? requestBody.text : "";
    const ts = slackTs();
    const msg: SlackMessage = {
      type: "message",
      ts,
      user: "U00MOCKBOT",
      text,
      channel,
    };
    const existing = state.sentMessages.get(channel) ?? [];
    existing.push(msg);
    state.sentMessages.set(channel, existing);
    return jsonFixture({
      ok: true,
      channel,
      ts,
      message: { type: "message", text, user: "U00MOCKBOT", ts },
    });
  }

  if (method === "GET" && pathname === "/api/conversations.list") {
    const channels: Array<{ id: string; name: string; is_member: boolean }> =
      [];
    for (const id of state.sentMessages.keys()) {
      channels.push({ id, name: id.toLowerCase(), is_member: true });
    }
    return jsonFixture({
      ok: true,
      channels,
      response_metadata: { next_cursor: "" },
    });
  }

  if (pathname === "/__mock/slack/sent") {
    if (method === "GET") {
      const all: SlackMessage[] = [];
      for (const msgs of state.sentMessages.values()) all.push(...msgs);
      return jsonFixture({ messages: all });
    }
    if (method === "DELETE") {
      state.sentMessages.clear();
      return jsonFixture({ ok: true });
    }
  }

  if (
    (pathname === "/__mock/slack/inbound" ||
      pathname === "/__mock/slack/inbound-event") &&
    method === "POST"
  ) {
    const channel =
      typeof requestBody.channel === "string" ? requestBody.channel : "C00MOCK";
    const text =
      typeof requestBody.text === "string" ? requestBody.text : "inbound";
    const user =
      typeof requestBody.user === "string" ? requestBody.user : "U00EXTERNAL";
    const msg: SlackMessage = {
      type: "message",
      ts: slackTs(),
      user,
      text,
      channel,
    };
    const existing = state.inboundMessages.get(channel) ?? [];
    existing.push(msg);
    state.inboundMessages.set(channel, existing);
    return jsonFixture({ ok: true, message: msg });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Telegram stateful mock
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  update_id: number;
  message: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: { id: number; type: string };
    date: number;
    text: string;
  };
}

interface TelegramMockState {
  nextUpdateId: number;
  pendingUpdates: TelegramUpdate[];
}

function createTelegramMockState(): TelegramMockState {
  return { nextUpdateId: 1, pendingUpdates: [] };
}

function telegramDynamicFixture(
  state: TelegramMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  // Match any `/bot<TOKEN>/<method>` path so callers can use either the
  // literal `:token` placeholder or a real-looking token string.
  const tokenMethodMatch = /^\/bot([^/]+)\/([A-Za-z]+)\/?$/.exec(pathname);
  const tgMethod = tokenMethodMatch?.[2];

  // getUpdates — consume pending queue (long-polling model)
  if ((method === "GET" || method === "POST") && tgMethod === "getUpdates") {
    const drained = state.pendingUpdates.splice(0, state.pendingUpdates.length);
    return jsonFixture({ ok: true, result: drained });
  }

  if (method === "GET" && tgMethod === "getMe") {
    return jsonFixture({
      ok: true,
      result: {
        id: 123456789,
        is_bot: true,
        first_name: "MockBot",
        username: "mock_eliza_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
    });
  }

  if (method === "POST" && tgMethod === "sendMessage") {
    const chatId =
      typeof requestBody.chat_id === "number"
        ? requestBody.chat_id
        : typeof requestBody.chat_id === "string"
          ? Number(requestBody.chat_id) || 0
          : 0;
    const text = typeof requestBody.text === "string" ? requestBody.text : "";
    return jsonFixture({
      ok: true,
      result: {
        message_id: Math.floor(Math.random() * 1000000),
        from: {
          id: 123456789,
          is_bot: true,
          first_name: "MockBot",
          username: "mock_eliza_bot",
        },
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    });
  }

  if (method === "POST" && tgMethod === "editMessageText") {
    const chatId =
      typeof requestBody.chat_id === "number"
        ? requestBody.chat_id
        : typeof requestBody.chat_id === "string"
          ? Number(requestBody.chat_id) || 0
          : 0;
    const messageId =
      typeof requestBody.message_id === "number" ? requestBody.message_id : 0;
    const text = typeof requestBody.text === "string" ? requestBody.text : "";
    return jsonFixture({
      ok: true,
      result: {
        message_id: messageId,
        from: {
          id: 123456789,
          is_bot: true,
          first_name: "MockBot",
          username: "mock_eliza_bot",
        },
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        edit_date: Math.floor(Date.now() / 1000),
        text,
      },
    });
  }

  if (method === "POST" && tgMethod === "sendChatAction") {
    return jsonFixture({ ok: true, result: true });
  }

  if (method === "POST" && tgMethod === "answerCallbackQuery") {
    return jsonFixture({ ok: true, result: true });
  }

  if (method === "POST" && tgMethod === "answerInlineQuery") {
    return jsonFixture({ ok: true, result: true });
  }

  if (method === "POST" && tgMethod === "setWebhook") {
    return jsonFixture({
      ok: true,
      result: true,
      description: "Webhook was set",
    });
  }

  if (method === "POST" && tgMethod === "deleteWebhook") {
    return jsonFixture({
      ok: true,
      result: true,
      description: "Webhook was deleted",
    });
  }

  if (method === "GET" && tgMethod === "getFile") {
    return jsonFixture({
      ok: true,
      result: {
        file_id: "mock-file-id",
        file_unique_id: "mock-unique-id",
        file_size: 12345,
        file_path: "photos/mock-file.jpg",
      },
    });
  }

  if (
    (pathname === "/__mock/telegram/inbound" ||
      pathname === "/__mock/telegram/inbound-update") &&
    method === "POST"
  ) {
    const chatId =
      typeof requestBody.chat_id === "number"
        ? requestBody.chat_id
        : typeof requestBody.chat_id === "string"
          ? Number(requestBody.chat_id) || 100000
          : 100000;
    const text =
      typeof requestBody.text === "string" ? requestBody.text : "inbound";
    const fromId =
      typeof requestBody.from_id === "number" ? requestBody.from_id : 200000;
    const fromName =
      typeof requestBody.from_name === "string"
        ? requestBody.from_name
        : "mock-user";
    const update: TelegramUpdate = {
      update_id: state.nextUpdateId++,
      message: {
        message_id: state.nextUpdateId * 10,
        from: { id: fromId, is_bot: false, first_name: fromName },
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    };
    state.pendingUpdates.push(update);
    return jsonFixture({ ok: true, update });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Linear stateful mock (GraphQL query dispatch)
// ---------------------------------------------------------------------------

interface LinearMockState {
  nextIssueId: number;
  issues: Array<{ id: string; title: string; state: string; teamId: string }>;
}

function createLinearMockState(): LinearMockState {
  return {
    nextIssueId: 1,
    issues: [
      {
        id: "issue-fix-001",
        title: "Fix login bug",
        state: "Todo",
        teamId: "team-eng",
      },
      {
        id: "issue-feat-001",
        title: "Add dark mode",
        state: "In Progress",
        teamId: "team-eng",
      },
    ],
  };
}

function linearDynamicFixture(
  state: LinearMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method !== "POST" || pathname !== "/graphql") return null;

  const query =
    typeof requestBody.query === "string" ? requestBody.query.trim() : "";

  // viewer query
  if (
    /^\s*(query\s+)?Viewer\b/i.test(query) ||
    query.includes("viewer {") ||
    query.includes("viewer{")
  ) {
    return jsonFixture({
      data: {
        viewer: {
          id: "user-mock-linear",
          name: "Mock User",
          email: "mock@example.test",
          displayName: "Mock User",
          active: true,
        },
      },
    });
  }

  // issues query
  if (/issues\s*\(/.test(query) && !/mutation/.test(query)) {
    return jsonFixture({
      data: {
        issues: {
          nodes: state.issues,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }

  // teams query
  if (/teams\s*\(/.test(query) || /\{\s*teams\s*\{/.test(query)) {
    return jsonFixture({
      data: {
        teams: {
          nodes: [{ id: "team-eng", name: "Engineering", key: "ENG" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }

  // single team query
  if (/\bteam\s*\(/.test(query) && !/teams\s*\(/.test(query)) {
    return jsonFixture({
      data: {
        team: { id: "team-eng", name: "Engineering", key: "ENG" },
      },
    });
  }

  // createIssue mutation
  if (
    /mutation\s+IssueCreate\b/i.test(query) ||
    (/mutation/.test(query) && /issueCreate/.test(query))
  ) {
    const vars = requestBody.variables;
    const input =
      vars && typeof vars === "object" && !Array.isArray(vars) && vars.input
        ? (vars.input as Record<string, string>)
        : {};
    const id = `issue-${randomFromAlphabet("0123456789abcdef", 8)}`;
    const title = typeof input.title === "string" ? input.title : "New issue";
    const teamId = typeof input.teamId === "string" ? input.teamId : "team-eng";
    const issue = { id, title, state: "Todo", teamId };
    state.issues.push(issue);
    return jsonFixture({
      data: {
        issueCreate: {
          success: true,
          issue,
        },
      },
    });
  }

  // updateIssue mutation
  if (
    /mutation\s+IssueUpdate\b/i.test(query) ||
    (/mutation/.test(query) && /issueUpdate/.test(query))
  ) {
    const vars = requestBody.variables;
    const input =
      vars && typeof vars === "object" && !Array.isArray(vars) && vars.input
        ? (vars.input as Record<string, string>)
        : {};
    const issueId =
      typeof vars === "object" &&
      vars &&
      !Array.isArray(vars) &&
      typeof vars.id === "string"
        ? vars.id
        : "";
    const existing =
      state.issues.find((i) => i.id === issueId) ?? state.issues[0];
    if (existing && typeof input.title === "string")
      existing.title = input.title;
    if (existing && typeof input.state === "string")
      existing.state = input.state;
    return jsonFixture({
      data: {
        issueUpdate: {
          success: true,
          issue: existing ?? null,
        },
      },
    });
  }

  // deleteIssue mutation
  if (
    /mutation\s+IssueDelete\b/i.test(query) ||
    (/mutation/.test(query) && /issueDelete/.test(query))
  ) {
    const vars = requestBody.variables;
    const issueId =
      vars &&
      typeof vars === "object" &&
      !Array.isArray(vars) &&
      typeof vars.id === "string"
        ? vars.id
        : "";
    const before = state.issues.length;
    state.issues = state.issues.filter((i) => i.id !== issueId);
    return jsonFixture({
      data: {
        issueDelete: {
          success: state.issues.length < before,
        },
      },
    });
  }

  // users query
  if (/^\s*(query\s+)?Users\b/i.test(query) || /\busers\s*\(/.test(query)) {
    return jsonFixture({
      data: {
        users: {
          nodes: [
            {
              id: "user-mock-linear",
              name: "Mock User",
              email: "mock@example.test",
              displayName: "Mock User",
              active: true,
            },
            {
              id: "user-mock-linear-2",
              name: "Mock Reviewer",
              email: "reviewer@example.test",
              displayName: "Mock Reviewer",
              active: true,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }

  // projects query
  if (
    /^\s*(query\s+)?Projects\b/i.test(query) ||
    /\bprojects\s*\(/.test(query)
  ) {
    return jsonFixture({
      data: {
        projects: {
          nodes: [
            {
              id: "project-mock-platform",
              name: "Platform",
              state: "started",
              progress: 0.42,
            },
            {
              id: "project-mock-growth",
              name: "Growth",
              state: "planned",
              progress: 0.0,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  }

  // baseline passthrough — let Mockoon static response handle it (returns null here)
  return null;
}

// ---------------------------------------------------------------------------
// Anthropic stateful mock (tool-use / computer-use dispatch)
// ---------------------------------------------------------------------------

interface AnthropicMockState {
  callCount: number;
}

function createAnthropicMockState(): AnthropicMockState {
  return { callCount: 0 };
}

// Prefix-keyed canned text responses. Keep entries short and matched against
// the first user message text (case-insensitive prefix). This is intentional:
// tests can drive deterministic behavior by choosing the prompt prefix.
const ANTHROPIC_PROMPT_RESPONSES: Array<{ prefix: string; text: string }> = [
  {
    prefix: "ping",
    text: "pong",
  },
  {
    prefix: "echo:",
    text: "echo response",
  },
  {
    prefix: "summarize",
    text: "Mock summary: the input was acknowledged.",
  },
  {
    prefix: "explain",
    text: "Mock explanation: deterministic fixture response from anthropic mock.",
  },
];

function firstUserMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (
      typeof msg === "object" &&
      msg !== null &&
      !Array.isArray(msg) &&
      (msg as Record<string, unknown>).role === "user"
    ) {
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            !Array.isArray(block) &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string"
          ) {
            return String((block as Record<string, unknown>).text);
          }
        }
      }
    }
  }
  return "";
}

function anthropicDynamicFixture(
  state: AnthropicMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method !== "POST" || pathname !== "/v1/messages") return null;

  state.callCount++;
  const tools = Array.isArray(requestBody.tools) ? requestBody.tools : [];

  // Detect computer-use tools
  const hasComputerUseTool = tools.some(
    (tool): boolean =>
      typeof tool === "object" &&
      tool !== null &&
      !Array.isArray(tool) &&
      typeof (tool as Record<string, unknown>).type === "string" &&
      String((tool as Record<string, unknown>).type).startsWith("computer_"),
  );

  if (hasComputerUseTool) {
    // Check if the last message is a tool_result (follow-up after screenshot)
    const messages = Array.isArray(requestBody.messages)
      ? requestBody.messages
      : [];
    const lastMessage = messages[messages.length - 1];
    const isToolResult =
      lastMessage &&
      typeof lastMessage === "object" &&
      !Array.isArray(lastMessage) &&
      (lastMessage as Record<string, unknown>).role === "user" &&
      Array.isArray((lastMessage as Record<string, unknown>).content) &&
      ((lastMessage as Record<string, unknown[]>).content as unknown[]).some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          !Array.isArray(block) &&
          (block as Record<string, unknown>).type === "tool_result",
      );

    if (isToolResult) {
      // After tool_result, respond with final text
      return jsonFixture({
        id: `msg_${randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 24)}`,
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Task completed after reviewing screenshot." },
        ],
        model: requestBody.model ?? "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 50, output_tokens: 12 },
      });
    }

    // First turn with computer-use: return screenshot tool_use
    return jsonFixture({
      id: `msg_${randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 24)}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 24)}`,
          name: "computer",
          input: { action: "screenshot" },
        },
      ],
      model: requestBody.model ?? "claude-haiku-4-5-20251001",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 15 },
    });
  }

  // Detect regular tool-use (non-computer tools)
  if (tools.length > 0) {
    const firstTool = tools[0];
    const toolName =
      typeof firstTool === "object" &&
      firstTool !== null &&
      !Array.isArray(firstTool) &&
      typeof (firstTool as Record<string, unknown>).name === "string"
        ? String((firstTool as Record<string, unknown>).name)
        : "mock_tool";

    return jsonFixture({
      id: `msg_${randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 24)}`,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 24)}`,
          name: toolName,
          input: {},
        },
      ],
      model: requestBody.model ?? "claude-haiku-4-5-20251001",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 10 },
    });
  }

  // No tools — return a prompt-keyed text response (or fall through to the
  // static Mockoon baseline if no prefix matches).
  const userText = firstUserMessageText(requestBody.messages)
    .trim()
    .toLowerCase();
  for (const entry of ANTHROPIC_PROMPT_RESPONSES) {
    if (userText.startsWith(entry.prefix)) {
      return jsonFixture({
        id: `msg_${randomFromAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 24)}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: entry.text }],
        model: requestBody.model ?? "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(5, Math.ceil(userText.length / 4)),
          output_tokens: Math.ceil(entry.text.length / 4),
        },
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vision stateful mock (image_hint dispatch)
// ---------------------------------------------------------------------------

interface VisionFixture {
  objects: Array<{ label: string; confidence: number; bbox: number[] }>;
  description: string;
  text: string;
}

const VISION_FIXTURES: Record<string, VisionFixture> = {
  "cat-fixture": {
    objects: [
      { label: "cat", confidence: 0.95, bbox: [10, 10, 100, 100] },
      { label: "sofa", confidence: 0.82, bbox: [0, 50, 400, 300] },
      { label: "indoor plant", confidence: 0.71, bbox: [300, 20, 380, 150] },
    ],
    description: "A scene with a cat resting on a sofa near an indoor plant.",
    text: "",
  },
  "document-fixture": {
    objects: [
      { label: "document", confidence: 0.97, bbox: [20, 30, 780, 1050] },
      { label: "text block", confidence: 0.91, bbox: [50, 80, 750, 400] },
    ],
    description: "A printed document with text content.",
    text: "Invoice #4831 — Amount Due: $1,234.56",
  },
  "street-fixture": {
    objects: [
      { label: "car", confidence: 0.93, bbox: [50, 100, 300, 250] },
      { label: "pedestrian", confidence: 0.87, bbox: [320, 80, 380, 260] },
      { label: "traffic light", confidence: 0.89, bbox: [450, 20, 480, 80] },
    ],
    description: "A city street with vehicles and pedestrians.",
    text: "",
  },
};

// Map image-bytes hashes to deterministic fixture keys. Tests can pin a
// fixture by sending an image whose sha256 maps to the desired key, or by
// passing image_hint in the request body.
const VISION_HASH_TO_FIXTURE: Record<string, string> = {};

const GENERIC_VISION_FIXTURE: VisionFixture = {
  objects: [],
  description: "No recognizable content (generic baseline response).",
  text: "",
};

function pickVisionFixture(requestBody: RequestBody): VisionFixture {
  const hint =
    typeof requestBody.image_hint === "string" ? requestBody.image_hint : "";
  if (hint && VISION_FIXTURES[hint]) return VISION_FIXTURES[hint];

  const imageBytes =
    typeof requestBody.image === "string"
      ? requestBody.image
      : typeof requestBody.image_base64 === "string"
        ? requestBody.image_base64
        : null;
  if (imageBytes) {
    const hash = crypto.createHash("sha256").update(imageBytes).digest("hex");
    const fixtureKey = VISION_HASH_TO_FIXTURE[hash];
    if (fixtureKey && VISION_FIXTURES[fixtureKey])
      return VISION_FIXTURES[fixtureKey];
    return GENERIC_VISION_FIXTURE;
  }

  // Legacy /v1/vision/analyze path defaults to cat-fixture for back-compat.
  return VISION_FIXTURES["cat-fixture"];
}

interface VisionMockState {
  callCount: number;
}

function createVisionMockState(): VisionMockState {
  return { callCount: 0 };
}

function visionDynamicFixture(
  state: VisionMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method !== "POST") return null;

  if (pathname === "/v1/vision/analyze") {
    state.callCount++;
    const hint =
      typeof requestBody.image_hint === "string"
        ? requestBody.image_hint
        : "cat-fixture";
    const fixture = VISION_FIXTURES[hint] ?? VISION_FIXTURES["cat-fixture"];
    return jsonFixture({
      ...fixture,
      request_id: `vis-${crypto.randomUUID()}`,
    });
  }

  if (pathname === "/v1/analyze") {
    state.callCount++;
    const fixture = pickVisionFixture(requestBody);
    return jsonFixture({
      ...fixture,
      request_id: `vis-${crypto.randomUUID()}`,
    });
  }

  if (pathname === "/v1/describe") {
    state.callCount++;
    const fixture = pickVisionFixture(requestBody);
    return jsonFixture({
      description: fixture.description,
      request_id: `vis-${crypto.randomUUID()}`,
    });
  }

  if (pathname === "/v1/objects") {
    state.callCount++;
    const fixture = pickVisionFixture(requestBody);
    return jsonFixture({
      objects: fixture.objects,
      request_id: `vis-${crypto.randomUUID()}`,
    });
  }

  if (pathname === "/v1/text") {
    state.callCount++;
    const fixture = pickVisionFixture(requestBody);
    return jsonFixture({
      text: fixture.text,
      blocks: fixture.text
        ? [{ text: fixture.text, bbox: [0, 0, 800, 1080], confidence: 0.95 }]
        : [],
      request_id: `vis-${crypto.randomUUID()}`,
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Payments stateful mock (generic request/link/status/callback provider)
// ---------------------------------------------------------------------------

type PaymentMockStatus = "requested" | "paid" | "failed" | "expired";

interface PaymentMockRequest {
  id: string;
  amountUsd: number;
  currency: string;
  status: PaymentMockStatus;
  accepted: boolean;
  provider: string;
  network: string;
  description: string;
  paymentUrl: string;
  checkoutUrl: string;
  callbackUrl?: string;
  callbackSecret?: string;
  channel?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  paidAt?: string;
  failedAt?: string;
  transactionHash?: string;
  failureReason?: string;
}

interface PaymentMockCallbackDelivery {
  paymentRequestId: string;
  event: string;
  url: string;
  delivered: boolean;
  statusCode?: number;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

interface PaymentMockState {
  requests: Map<string, PaymentMockRequest>;
  callbacks: PaymentMockCallbackDelivery[];
}

function createPaymentMockState(): PaymentMockState {
  return { requests: new Map(), callbacks: [] };
}

function readMoney(body: RequestBody, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value * 100) / 100;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.round(parsed * 100) / 100;
      }
    }
  }
  return null;
}

function jsonRecordValue(
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function paymentMockOrigin(headers: http.IncomingHttpHeaders): string {
  const host = headerValue(headers, "host") ?? "127.0.0.1";
  const proto = headerValue(headers, "x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

function paymentMockView(
  request: PaymentMockRequest,
): Record<string, JsonValue> {
  return {
    id: request.id,
    amountUsd: request.amountUsd,
    currency: request.currency,
    status: request.status,
    paid: request.status === "paid",
    accepted: request.accepted,
    provider: request.provider,
    network: request.network,
    description: request.description,
    paymentUrl: request.paymentUrl,
    checkoutUrl: request.checkoutUrl,
    callbackUrl: request.callbackUrl ?? null,
    callbackSecretSet: Boolean(request.callbackSecret),
    channel: request.channel ?? null,
    metadata: request.metadata ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    expiresAt: request.expiresAt,
    paidAt: request.paidAt ?? null,
    failedAt: request.failedAt ?? null,
    transactionHash: request.transactionHash ?? null,
    failureReason: request.failureReason ?? null,
  };
}

function paymentMockAppId(request: PaymentMockRequest): string | null {
  const appId = request.metadata?.app_id ?? request.metadata?.appId;
  return typeof appId === "string" && appId.length > 0 ? appId : null;
}

function paymentMockProviders(request: PaymentMockRequest): string[] {
  const raw = request.metadata?.providers;
  if (!Array.isArray(raw)) return ["stripe", "oxapay"];
  const providers = raw.filter(
    (provider): provider is string =>
      provider === "stripe" || provider === "oxapay",
  );
  return providers.length > 0 ? providers : ["stripe", "oxapay"];
}

function paymentMockAppChargeView(
  request: PaymentMockRequest,
): Record<string, JsonValue> {
  const appId = paymentMockAppId(request) ?? "mock-app";
  return {
    id: request.id,
    appId,
    amountUsd: request.amountUsd,
    description: request.description,
    providers: paymentMockProviders(request),
    paymentUrl: request.paymentUrl,
    status: request.status === "paid" ? "confirmed" : request.status,
    paidAt: request.paidAt ?? null,
    paidProvider: request.provider === "mock" ? null : request.provider,
    providerPaymentId: request.transactionHash ? request.id : null,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
    metadata: request.metadata ?? null,
  };
}

function readPaymentProviders(body: RequestBody): string[] {
  const providers = readStringArray(body, "providers").filter(
    (provider) => provider === "stripe" || provider === "oxapay",
  );
  return providers.length > 0 ? providers : ["stripe", "oxapay"];
}

function setPaymentLedger(
  ledgerEntry: MockRequestLedgerEntry,
  metadata: Omit<PaymentRequestLedgerMetadata, "runId">,
): void {
  ledgerEntry.payment = withRunId<PaymentRequestLedgerMetadata>(
    ledgerEntry,
    metadata,
  );
}

async function paymentCallbackSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return `sha256=${crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
}

async function dispatchPaymentMockCallback(
  state: PaymentMockState,
  request: PaymentMockRequest,
  event: "payment_request.paid" | "payment_request.failed",
): Promise<boolean> {
  const createdAt = new Date().toISOString();
  if (!request.callbackUrl) {
    if (!request.channel) return false;
    const roomId =
      typeof request.channel.roomId === "string"
        ? request.channel.roomId
        : request.id;
    state.callbacks.push({
      paymentRequestId: request.id,
      event,
      url: `channel://${encodeURIComponent(roomId)}`,
      delivered: true,
      statusCode: 202,
      createdAt,
      completedAt: createdAt,
    });
    return true;
  }

  const payload = {
    event,
    createdAt,
    paymentRequest: paymentMockView(request),
    payment: {
      provider: request.provider,
      providerPaymentId: request.id,
      amountUsd: request.amountUsd,
      status: request.status,
      transactionHash: request.transactionHash ?? null,
      failureReason: request.failureReason ?? null,
    },
    channel: request.channel ?? undefined,
    metadata: request.metadata ?? undefined,
  };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Eliza-Mock-Payments/1.0",
    "X-Eliza-Event": event,
    "X-Eliza-Timestamp": createdAt,
    "X-Eliza-Delivery": crypto.randomUUID(),
  };
  if (request.callbackSecret) {
    headers["X-Eliza-Signature"] = await paymentCallbackSignature(
      request.callbackSecret,
      createdAt,
      body,
    );
  }

  const delivery: PaymentMockCallbackDelivery = {
    paymentRequestId: request.id,
    event,
    url: request.callbackUrl,
    delivered: false,
    createdAt,
  };
  state.callbacks.push(delivery);

  try {
    const response = await fetch(request.callbackUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5_000),
    });
    delivery.statusCode = response.status;
    delivery.delivered = response.ok;
    delivery.completedAt = new Date().toISOString();
    return response.ok;
  } catch (error) {
    delivery.error = error instanceof Error ? error.message : String(error);
    delivery.completedAt = new Date().toISOString();
    return false;
  }
}

function paymentRequestByPath(
  state: PaymentMockState,
  pathname: string,
  pattern: RegExp,
): PaymentMockRequest | null {
  const id = routeParam(pathname, pattern);
  return id ? (state.requests.get(id) ?? null) : null;
}

async function paymentDynamicFixture(
  state: PaymentMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  headers: http.IncomingHttpHeaders,
  ledgerEntry: MockRequestLedgerEntry,
): Promise<DynamicFixtureResponse | null> {
  if (method === "GET" && pathname === "/__mock/payments/requests") {
    setPaymentLedger(ledgerEntry, { action: "payment_requests.mock_list" });
    return jsonFixture({
      paymentRequests: Array.from(state.requests.values()).map(paymentMockView),
      appCharges: Array.from(state.requests.values())
        .filter((request) => request.metadata?.kind === "app_charge_request")
        .map(paymentMockAppChargeView),
      callbacks: state.callbacks,
    });
  }

  if (
    (method === "POST" && pathname === "/__mock/payments/reset") ||
    (method === "DELETE" && pathname === "/__mock/payments/requests")
  ) {
    state.requests.clear();
    state.callbacks.splice(0, state.callbacks.length);
    setPaymentLedger(ledgerEntry, { action: "payment_requests.reset" });
    return jsonFixture({ ok: true });
  }

  const appChargeCreateMatch = /^\/api\/v1\/apps\/([^/]+)\/charges\/?$/.exec(
    pathname,
  );
  if (method === "POST" && appChargeCreateMatch) {
    const amountUsd = readMoney(
      requestBody,
      "amountUsd",
      "amount_usd",
      "amount",
    );
    if (amountUsd === null) {
      throw new MockHttpError(400, "amountUsd must be a positive number");
    }

    const appId = decodeURIComponent(appChargeCreateMatch[1] ?? "mock-app");
    const origin = paymentMockOrigin(headers);
    const id = `charge_${crypto.randomUUID()}`;
    const now = new Date();
    const expiresInSeconds =
      typeof requestBody.lifetimeSeconds === "number" &&
      Number.isFinite(requestBody.lifetimeSeconds)
        ? Math.max(60, Math.floor(requestBody.lifetimeSeconds))
        : 7 * 24 * 60 * 60;
    const providers = readPaymentProviders(requestBody);
    const metadata = {
      ...(jsonRecordValue(requestBody.metadata) ?? {}),
      kind: "app_charge_request",
      app_id: appId,
      amount_usd: amountUsd,
      providers,
      payment_url: `${origin}/payment/app-charge/${encodeURIComponent(appId)}/${encodeURIComponent(id)}`,
      callback_url:
        readOptionalString(requestBody, "callbackUrl") ??
        readOptionalString(requestBody, "callback_url") ??
        undefined,
      callback_channel:
        jsonRecordValue(requestBody.callbackChannel) ??
        jsonRecordValue(requestBody.callback_channel) ??
        undefined,
      callback_metadata:
        jsonRecordValue(requestBody.callbackMetadata) ??
        jsonRecordValue(requestBody.callback_metadata) ??
        undefined,
    } satisfies Record<string, JsonValue | undefined>;
    const request: PaymentMockRequest = {
      id,
      amountUsd,
      currency: "USD",
      status: "requested",
      accepted: false,
      provider: "app-charge",
      network: "app-charge",
      description:
        readOptionalString(requestBody, "description") ?? "Mock app charge",
      paymentUrl: metadata.payment_url as string,
      checkoutUrl: `${origin}/checkout/${encodeURIComponent(id)}`,
      callbackUrl:
        readOptionalString(requestBody, "callbackUrl") ??
        readOptionalString(requestBody, "callback_url") ??
        undefined,
      callbackSecret:
        readOptionalString(requestBody, "callbackSecret") ??
        readOptionalString(requestBody, "callback_secret") ??
        undefined,
      channel:
        jsonRecordValue(requestBody.channel) ??
        jsonRecordValue(requestBody.callbackChannel) ??
        jsonRecordValue(requestBody.callback_channel),
      metadata: metadata as Record<string, JsonValue>,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + expiresInSeconds * 1000,
      ).toISOString(),
    };
    state.requests.set(id, request);
    setPaymentLedger(ledgerEntry, {
      action: "app_charges.create",
      paymentRequestId: id,
      status: request.status,
      amountUsd,
    });
    return jsonFixture(
      { success: true, charge: paymentMockAppChargeView(request) },
      201,
    );
  }

  const appChargeGetMatch =
    /^\/api\/v1\/apps\/([^/]+)\/charges\/([^/]+)\/?$/.exec(pathname);
  if (method === "GET" && appChargeGetMatch) {
    const appId = decodeURIComponent(appChargeGetMatch[1] ?? "");
    const chargeId = decodeURIComponent(appChargeGetMatch[2] ?? "");
    const request = state.requests.get(chargeId);
    if (!request || paymentMockAppId(request) !== appId) {
      return mockJsonError(404, "app_charge_not_found");
    }
    setPaymentLedger(ledgerEntry, {
      action: "app_charges.get",
      paymentRequestId: request.id,
      status: request.status,
      amountUsd: request.amountUsd,
    });
    return jsonFixture({
      success: true,
      charge: paymentMockAppChargeView(request),
    });
  }

  const appChargeCheckoutMatch =
    /^\/api\/v1\/apps\/([^/]+)\/charges\/([^/]+)\/checkout\/?$/.exec(pathname);
  if (method === "POST" && appChargeCheckoutMatch) {
    const appId = decodeURIComponent(appChargeCheckoutMatch[1] ?? "");
    const chargeId = decodeURIComponent(appChargeCheckoutMatch[2] ?? "");
    const request = state.requests.get(chargeId);
    if (!request || paymentMockAppId(request) !== appId) {
      return mockJsonError(404, "app_charge_not_found");
    }
    const provider = readOptionalString(requestBody, "provider") ?? "oxapay";
    const providers = paymentMockProviders(request);
    if (!providers.includes(provider)) {
      return mockJsonError(400, "provider_not_enabled");
    }
    request.provider = provider;
    request.updatedAt = new Date().toISOString();
    setPaymentLedger(ledgerEntry, {
      action: "app_charges.checkout",
      paymentRequestId: request.id,
      status: request.status,
      amountUsd: request.amountUsd,
    });
    if (provider === "stripe") {
      return jsonFixture({
        success: true,
        checkout: {
          provider: "stripe",
          url: `${request.checkoutUrl}?provider=stripe`,
          sessionId: `cs_mock_${request.id}`,
        },
      });
    }
    return jsonFixture({
      success: true,
      checkout: {
        provider: "oxapay",
        paymentId: request.id,
        trackId: request.id,
        payLink: `${request.checkoutUrl}?provider=oxapay`,
        expiresAt: request.expiresAt,
      },
    });
  }

  if (method === "POST" && pathname === "/v1/payment-requests") {
    const amountUsd = readMoney(
      requestBody,
      "amountUsd",
      "amount_usd",
      "amount",
    );
    if (amountUsd === null) {
      throw new MockHttpError(400, "amountUsd must be a positive number");
    }

    const origin = paymentMockOrigin(headers);
    const id = `payreq_${crypto.randomUUID()}`;
    const now = new Date();
    const expiresInSeconds =
      typeof requestBody.expiresInSeconds === "number" &&
      Number.isFinite(requestBody.expiresInSeconds)
        ? Math.max(60, Math.floor(requestBody.expiresInSeconds))
        : 900;
    const request: PaymentMockRequest = {
      id,
      amountUsd,
      currency: readOptionalString(requestBody, "currency") ?? "USD",
      status: "requested",
      accepted: false,
      provider: readOptionalString(requestBody, "provider") ?? "mock",
      network: readOptionalString(requestBody, "network") ?? "mock",
      description:
        readOptionalString(requestBody, "description") ??
        "Mock payment request",
      paymentUrl: `${origin}/checkout/${encodeURIComponent(id)}`,
      checkoutUrl: `${origin}/checkout/${encodeURIComponent(id)}`,
      callbackUrl:
        readOptionalString(requestBody, "callbackUrl") ??
        readOptionalString(requestBody, "callback_url") ??
        undefined,
      callbackSecret:
        readOptionalString(requestBody, "callbackSecret") ??
        readOptionalString(requestBody, "callback_secret") ??
        undefined,
      channel:
        jsonRecordValue(requestBody.channel) ??
        jsonRecordValue(requestBody.callbackChannel) ??
        jsonRecordValue(requestBody.callback_channel),
      metadata: jsonRecordValue(requestBody.metadata),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + expiresInSeconds * 1000,
      ).toISOString(),
    };
    state.requests.set(id, request);
    setPaymentLedger(ledgerEntry, {
      action: "payment_requests.create",
      paymentRequestId: id,
      status: request.status,
      amountUsd,
    });
    return jsonFixture(
      { success: true, paymentRequest: paymentMockView(request) },
      201,
    );
  }

  if (method === "GET") {
    const request =
      paymentRequestByPath(
        state,
        pathname,
        /^\/v1\/payment-requests\/([^/]+)\/?$/,
      ) ?? paymentRequestByPath(state, pathname, /^\/checkout\/([^/]+)\/?$/);
    if (request) {
      setPaymentLedger(ledgerEntry, {
        action: pathname.startsWith("/checkout/")
          ? "payment_requests.checkout"
          : "payment_requests.get",
        paymentRequestId: request.id,
        status: request.status,
        amountUsd: request.amountUsd,
      });
      return jsonFixture({
        success: true,
        paymentRequest: paymentMockView(request),
      });
    }
  }

  const payId =
    method === "POST"
      ? (routeParam(
          pathname,
          /^\/v1\/payment-requests\/([^/]+)\/(?:pay|confirm|settle)\/?$/,
        ) ??
        routeParam(
          pathname,
          /^\/__mock\/payments\/([^/]+)\/(?:pay|confirm|settle)\/?$/,
        ) ??
        routeParam(
          pathname,
          /^\/__mock\/app-charges\/([^/]+)\/(?:pay|confirm|settle)\/?$/,
        ))
      : null;
  if (payId) {
    const request = state.requests.get(payId);
    if (!request) return mockJsonError(404, "payment_request_not_found");
    const now = new Date().toISOString();
    request.status = "paid";
    request.accepted = true;
    request.updatedAt = now;
    request.paidAt = request.paidAt ?? now;
    request.transactionHash =
      readOptionalString(requestBody, "transactionHash") ??
      readOptionalString(requestBody, "transaction_hash") ??
      request.transactionHash ??
      `mock_tx_${crypto.randomUUID()}`;
    const callbackDelivered = await dispatchPaymentMockCallback(
      state,
      request,
      "payment_request.paid",
    );
    setPaymentLedger(ledgerEntry, {
      action: "payment_requests.pay",
      paymentRequestId: request.id,
      status: request.status,
      amountUsd: request.amountUsd,
      callbackDelivered,
    });
    return jsonFixture({
      success: true,
      accepted: true,
      paymentRequest: paymentMockView(request),
    });
  }

  const failId =
    method === "POST"
      ? (routeParam(pathname, /^\/v1\/payment-requests\/([^/]+)\/fail\/?$/) ??
        routeParam(pathname, /^\/__mock\/payments\/([^/]+)\/fail\/?$/))
      : null;
  if (failId) {
    const request = state.requests.get(failId);
    if (!request) return mockJsonError(404, "payment_request_not_found");
    if (request.status === "paid") {
      return mockJsonError(409, "payment_request_already_paid");
    }
    const now = new Date().toISOString();
    request.status = "failed";
    request.accepted = false;
    request.updatedAt = now;
    request.failedAt = now;
    request.failureReason =
      readOptionalString(requestBody, "reason") ??
      readOptionalString(requestBody, "failureReason") ??
      "mock_failure";
    const callbackDelivered = await dispatchPaymentMockCallback(
      state,
      request,
      "payment_request.failed",
    );
    setPaymentLedger(ledgerEntry, {
      action: "payment_requests.fail",
      paymentRequestId: request.id,
      status: request.status,
      amountUsd: request.amountUsd,
      callbackDelivered,
    });
    return jsonFixture({
      success: true,
      accepted: false,
      paymentRequest: paymentMockView(request),
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shopify stateful mock (single-record GETs by id; the static Mockoon route
// compiler treats ":id.json" as one literal-ish param so we route those here)
// ---------------------------------------------------------------------------

interface ShopifyMockState {
  callCount: number;
}

function createShopifyMockState(): ShopifyMockState {
  return { callCount: 0 };
}

function shopifyDynamicFixture(
  state: ShopifyMockState,
  method: string,
  pathname: string,
  _requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method !== "GET") return null;

  // /admin/api/2024-10/products/<id>.json
  const productId = routeParam(
    pathname,
    /^\/admin\/api\/[^/]+\/products\/([^/]+?)\.json$/,
  );
  if (productId) {
    state.callCount++;
    return jsonFixture({
      product: {
        id: Number(productId) || productId,
        title: "Mock Widget",
        body_html: "<p>A great mock product.</p>",
        vendor: "Mock Vendor",
        product_type: "Widget",
        handle: "mock-widget",
        status: "active",
        variants: [
          {
            id: 9876543210,
            product_id: Number(productId) || productId,
            title: "Default Title",
            price: "19.99",
            sku: "MOCK-001",
            inventory_quantity: 100,
            inventory_item_id: 7000000001,
          },
        ],
        images: [],
        tags: "mock,test",
        created_at: "2026-01-01T00:00:00-05:00",
        updated_at: "2026-01-01T00:00:00-05:00",
      },
    });
  }

  // /admin/api/2024-10/orders/<id>.json
  const orderId = routeParam(
    pathname,
    /^\/admin\/api\/[^/]+\/orders\/([^/]+?)\.json$/,
  );
  if (orderId) {
    state.callCount++;
    return jsonFixture({
      order: {
        id: Number(orderId) || orderId,
        order_number: 1001,
        email: "customer@example.test",
        created_at: "2026-04-01T10:00:00-05:00",
        updated_at: "2026-04-01T10:05:00-05:00",
        total_price: "59.98",
        subtotal_price: "59.98",
        total_tax: "0.00",
        currency: "USD",
        financial_status: "paid",
        fulfillment_status: null,
        line_items: [
          {
            id: 1,
            title: "Mock Widget",
            quantity: 2,
            price: "19.99",
            sku: "MOCK-001",
          },
        ],
        customer: {
          id: 9000000001,
          email: "customer@example.test",
          first_name: "Test",
          last_name: "Customer",
        },
      },
    });
  }

  // /admin/api/2024-10/customers/<id>.json
  const customerId = routeParam(
    pathname,
    /^\/admin\/api\/[^/]+\/customers\/([^/]+?)\.json$/,
  );
  if (customerId) {
    state.callCount++;
    return jsonFixture({
      customer: {
        id: Number(customerId) || customerId,
        email: "customer@example.test",
        first_name: "Test",
        last_name: "Customer",
        phone: null,
        verified_email: true,
        tax_exempt: false,
        tags: "",
        currency: "USD",
        orders_count: 1,
        total_spent: "59.98",
        state: "enabled",
        created_at: "2026-01-15T00:00:00-05:00",
        updated_at: "2026-04-01T10:05:00-05:00",
      },
    });
  }

  return null;
}

// ---------------------------------------------------------------------------
// OpenAI stateful mock (deterministic hash-seeded embeddings + image gen)
// ---------------------------------------------------------------------------

interface OpenAIMockState {
  callCount: number;
}

function createOpenAIMockState(): OpenAIMockState {
  return { callCount: 0 };
}

function deterministicEmbedding(input: string, dim = 1536): number[] {
  // Seed a 1536-dim vector by hashing the input string. Each 4-byte slice of
  // a chained sha256 stream produces one float in (-1, 1). Same input always
  // yields the same vector; different inputs produce visibly different
  // vectors but the magnitudes stay normalized-ish (range ~[-1, 1]).
  const out = new Array<number>(dim);
  let seed = crypto.createHash("sha256").update(input).digest();
  let cursor = 0;
  let block = 0;
  for (let i = 0; i < dim; i++) {
    if (cursor + 4 > seed.length) {
      block++;
      seed = crypto
        .createHash("sha256")
        .update(seed)
        .update(String(block))
        .digest();
      cursor = 0;
    }
    const u = seed.readUInt32BE(cursor);
    cursor += 4;
    // Map 0..2^32-1 to (-1, 1).
    out[i] = (u / 0xffffffff) * 2 - 1;
  }
  return out;
}

function openaiDynamicFixture(
  state: OpenAIMockState,
  method: string,
  pathname: string,
  requestBody: RequestBody,
  _ledgerEntry: MockRequestLedgerEntry,
): DynamicFixtureResponse | null {
  if (method !== "POST") return null;

  if (pathname === "/v1/embeddings") {
    state.callCount++;
    const inputRaw = requestBody.input;
    const inputs: string[] = Array.isArray(inputRaw)
      ? inputRaw.map((v) => String(v))
      : [String(inputRaw ?? "")];
    const model =
      typeof requestBody.model === "string"
        ? requestBody.model
        : "text-embedding-3-small";
    const data = inputs.map((text, idx) => ({
      object: "embedding",
      index: idx,
      embedding: deterministicEmbedding(text, 1536),
    }));
    const totalTokens = inputs.reduce(
      (acc, s) => acc + Math.max(1, Math.ceil(s.length / 4)),
      0,
    );
    return jsonFixture({
      object: "list",
      data,
      model,
      usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
    });
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
  | { kind: "discord"; state: DiscordMockState }
  | { kind: "slack"; state: SlackMockState }
  | { kind: "telegram"; state: TelegramMockState }
  | { kind: "linear"; state: LinearMockState }
  | { kind: "anthropic"; state: AnthropicMockState }
  | { kind: "vision"; state: VisionMockState }
  | { kind: "openai"; state: OpenAIMockState }
  | { kind: "shopify"; state: ShopifyMockState }
  | { kind: "payments"; state: PaymentMockState }
  | null;

function createDynamicProviderState(
  environmentName: string | undefined,
  opts?: MockFixtureOptions,
): DynamicProviderState {
  if (environmentName === "Google APIs") {
    return { kind: "google", state: createGoogleMockState(opts) };
  }
  if (environmentName === "X (Twitter)") {
    return { kind: "x-twitter", state: createXMockState() };
  }
  if (environmentName === "WhatsApp") {
    return { kind: "whatsapp", state: createWhatsAppMockState(opts) };
  }
  if (environmentName === "Signal HTTP") {
    return { kind: "signal", state: createSignalMockState(opts) };
  }
  if (environmentName === "Browser Workspace") {
    return {
      kind: "browser-workspace",
      state: createBrowserWorkspaceMockState(opts),
    };
  }
  if (environmentName === "BlueBubbles" || environmentName === "iMessage") {
    return { kind: "bluebubbles", state: createBlueBubblesMockState(opts) };
  }
  if (environmentName === "GitHub REST") {
    return { kind: "github", state: createGitHubMockState() };
  }
  if (environmentName === "Discord REST") {
    return { kind: "discord", state: createDiscordMockState() };
  }
  if (environmentName === "Slack Web API") {
    return { kind: "slack", state: createSlackMockState() };
  }
  if (environmentName === "Telegram Bot API") {
    return { kind: "telegram", state: createTelegramMockState() };
  }
  if (environmentName === "Linear GraphQL") {
    return { kind: "linear", state: createLinearMockState() };
  }
  if (environmentName === "Anthropic Messages API") {
    return { kind: "anthropic", state: createAnthropicMockState() };
  }
  if (environmentName === "Vision Analysis API") {
    return { kind: "vision", state: createVisionMockState() };
  }
  if (environmentName === "OpenAI API") {
    return { kind: "openai", state: createOpenAIMockState() };
  }
  if (environmentName === "Shopify Admin API") {
    return { kind: "shopify", state: createShopifyMockState() };
  }
  if (environmentName === "Payments API") {
    return { kind: "payments", state: createPaymentMockState() };
  }
  return null;
}

async function dynamicProviderFixture(args: {
  provider: DynamicProviderState;
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  requestBody: RequestBody;
  headers: http.IncomingHttpHeaders;
  ledgerEntry: MockRequestLedgerEntry;
}): Promise<DynamicFixtureResponse | null> {
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
    case "discord":
      return discordDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "slack":
      return slackDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "telegram":
      return telegramDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "linear":
      return linearDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "anthropic":
      return anthropicDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "vision":
      return visionDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "openai":
      return openaiDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "shopify":
      return shopifyDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.ledgerEntry,
      );
    case "payments":
      return paymentDynamicFixture(
        args.provider.state,
        args.method,
        args.pathname,
        args.requestBody,
        args.headers,
        args.ledgerEntry,
      );
  }
}

async function startFixtureServer(
  dataPath: string,
  opts?: MockFixtureOptions,
): Promise<StartedFixtureServer> {
  const environment = readEnvironment(dataPath);
  const routes = compileRoutes(environment);
  const requests: MockRequestLedgerEntry[] = [];
  const isLifeOpsPresenceActiveEnvironment =
    environment.name === "LifeOps Presence Active Scenarios";
  const lifeOpsTasks = new Map<
    string,
    { scenarioId: string; snapshotIndex: number }
  >();
  const dynamicProvider = createDynamicProviderState(environment.name, opts);
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
      if (
        method === "GET" &&
        requestUrl.pathname === "/__mock/lifeops/simulator"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            enabled: Boolean(opts?.simulator),
            summary: opts?.simulator ? lifeOpsSimulatorSummary() : null,
          }),
        );
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
      if (
        isLifeOpsPresenceActiveEnvironment &&
        method === "GET" &&
        requestUrl.pathname === "/__mock/lifeops/presence-active/scenarios"
      ) {
        ledgerEntry.lifeopsPresenceActive =
          withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
            action: "scenarios.list",
          });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            version: LIFEOPS_PRESENCE_ACTIVE_FIXTURE_CATALOG.version,
            scenarioCount:
              LIFEOPS_PRESENCE_ACTIVE_FIXTURE_CATALOG.scenarioCount,
            providers: LIFEOPS_PRESENCE_ACTIVE_FIXTURE_CATALOG.providers,
            scenarios: lifeOpsPresenceActiveScenarioSummaries(),
          }),
        );
        return;
      }
      const lifeOpsScenarioId = isLifeOpsPresenceActiveEnvironment
        ? routeParam(
            requestUrl.pathname,
            /^\/__mock\/lifeops\/presence-active\/scenarios\/([^/]+)\/?$/,
          )
        : null;
      if (method === "GET" && lifeOpsScenarioId) {
        const scenario = findLifeOpsPresenceActiveScenario(lifeOpsScenarioId);
        ledgerEntry.lifeopsPresenceActive =
          withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
            action: "scenarios.get",
            scenarioId: lifeOpsScenarioId,
          });
        if (!scenario) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "scenario_not_found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ scenario }));
        return;
      }
      if (
        isLifeOpsPresenceActiveEnvironment &&
        method === "POST" &&
        requestUrl.pathname === "/__mock/lifeops/presence-active/tasks"
      ) {
        const scenarioId =
          typeof requestBody.scenarioId === "string"
            ? requestBody.scenarioId
            : "move-07-proactive-multihop-and-long-running";
        const scenario = findLifeOpsPresenceActiveScenario(scenarioId);
        if (!scenario) {
          ledgerEntry.lifeopsPresenceActive =
            withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
              action: "tasks.create.rejected",
              scenarioId,
              status: "unknown_scenario",
            });
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown_scenario", scenarioId }));
          return;
        }
        const snapshots = lifeOpsPresenceActiveTaskSnapshots(scenarioId);
        if (
          snapshots.length === 0 ||
          !scenario.useCases.includes("long-running")
        ) {
          ledgerEntry.lifeopsPresenceActive =
            withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
              action: "tasks.create.rejected",
              scenarioId,
              status: "not_long_running",
            });
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "scenario_not_long_running",
              scenarioId,
            }),
          );
          return;
        }
        const taskId = `lifeops-${crypto.randomUUID()}`;
        lifeOpsTasks.set(taskId, { scenarioId, snapshotIndex: 0 });
        ledgerEntry.lifeopsPresenceActive =
          withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
            action: "tasks.create",
            scenarioId,
            taskId,
            status: snapshots[0]?.status,
          });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task: snapshots[0]
              ? { ...snapshots[0], taskId }
              : {
                  taskId,
                  scenarioId,
                  status: "queued",
                  step: "Task queued.",
                  percentComplete: 0,
                  nextPollMs: 1000,
                },
            taskId,
            pollUrl: `/__mock/lifeops/presence-active/tasks/${taskId}`,
          }),
        );
        return;
      }
      const lifeOpsAdvanceTaskId = isLifeOpsPresenceActiveEnvironment
        ? routeParam(
            requestUrl.pathname,
            /^\/__mock\/lifeops\/presence-active\/tasks\/([^/]+)\/advance\/?$/,
          )
        : null;
      if (method === "POST" && lifeOpsAdvanceTaskId) {
        const task =
          lifeOpsTasks.get(lifeOpsAdvanceTaskId) ??
          (lifeOpsAdvanceTaskId === "task-vendor-packet-watch-001"
            ? {
                scenarioId: "move-07-proactive-multihop-and-long-running",
                snapshotIndex: 0,
              }
            : null);
        if (!task) {
          ledgerEntry.lifeopsPresenceActive =
            withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
              action: "tasks.advance.not_found",
              taskId: lifeOpsAdvanceTaskId,
            });
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "task_not_found" }));
          return;
        }
        const snapshots = lifeOpsPresenceActiveTaskSnapshots(task.scenarioId);
        task.snapshotIndex = Math.min(
          task.snapshotIndex + 1,
          Math.max(0, snapshots.length - 1),
        );
        lifeOpsTasks.set(lifeOpsAdvanceTaskId, task);
        const snapshot = snapshots[task.snapshotIndex] ?? null;
        ledgerEntry.lifeopsPresenceActive =
          withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
            action: "tasks.advance",
            scenarioId: task.scenarioId,
            taskId: lifeOpsAdvanceTaskId,
            status: snapshot?.status,
          });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task: snapshot
              ? { ...snapshot, taskId: lifeOpsAdvanceTaskId }
              : null,
          }),
        );
        return;
      }
      const lifeOpsTaskId = isLifeOpsPresenceActiveEnvironment
        ? routeParam(
            requestUrl.pathname,
            /^\/__mock\/lifeops\/presence-active\/tasks\/([^/]+)\/?$/,
          )
        : null;
      if (method === "GET" && lifeOpsTaskId) {
        const task =
          lifeOpsTasks.get(lifeOpsTaskId) ??
          (lifeOpsTaskId === "task-vendor-packet-watch-001"
            ? {
                scenarioId: "move-07-proactive-multihop-and-long-running",
                snapshotIndex: 0,
              }
            : null);
        if (!task) {
          ledgerEntry.lifeopsPresenceActive =
            withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
              action: "tasks.get.not_found",
              taskId: lifeOpsTaskId,
            });
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "task_not_found" }));
          return;
        }
        const snapshots = lifeOpsPresenceActiveTaskSnapshots(task.scenarioId);
        const snapshot = snapshots[task.snapshotIndex] ?? null;
        ledgerEntry.lifeopsPresenceActive =
          withRunId<LifeOpsPresenceActiveRequestLedgerMetadata>(ledgerEntry, {
            action: "tasks.get",
            scenarioId: task.scenarioId,
            taskId: lifeOpsTaskId,
            status: snapshot?.status,
          });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            task: snapshot ? { ...snapshot, taskId: lifeOpsTaskId } : null,
          }),
        );
        return;
      }
      const dynamicResponse = await dynamicProviderFixture({
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
  simulator?: boolean;
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
      servers.push(
        await startFixtureServer(dataPath, {
          simulator: Boolean(opts?.simulator),
        }),
      );
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

// ---------------------------------------------------------------------------
// CLI entrypoint — `bunx tsx test/mocks/scripts/start-mocks.ts --envs a,b,c`
// ---------------------------------------------------------------------------

function parseCliArgs(argv: readonly string[]): {
  envs: readonly MockEnvironmentName[] | undefined;
  simulator: boolean;
} {
  let envs: readonly MockEnvironmentName[] | undefined;
  let simulator = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--simulator" || arg === "--seed-simulator") {
      simulator = true;
      continue;
    }
    if (arg === "--envs" || arg === "-e") {
      const value = argv[i + 1];
      if (!value) throw new Error("--envs requires a comma-separated list");
      envs = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as readonly MockEnvironmentName[];
      i++;
      continue;
    }
    if (arg.startsWith("--envs=")) {
      envs = arg
        .slice("--envs=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as readonly MockEnvironmentName[];
    }
  }
  return { envs, simulator };
}

const isCliInvocation =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCliInvocation) {
  const { envs, simulator } = parseCliArgs(process.argv.slice(2));
  startMocks({ envs, simulator })
    .then((mocks) => {
      const lines: string[] = [];
      lines.push("Mock servers running. Press Ctrl+C to stop.");
      for (const [name, baseUrl] of Object.entries(mocks.baseUrls)) {
        lines.push(`  ${name.padEnd(20)} ${baseUrl}`);
      }
      lines.push("");
      lines.push("Env vars:");
      for (const [k, v] of Object.entries(mocks.envVars)) {
        lines.push(`  ${k}=${v}`);
      }
      console.log(lines.join("\n"));

      const shutdown = async (): Promise<void> => {
        await mocks.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("Failed to start mocks:", err);
      process.exit(1);
    });
}
