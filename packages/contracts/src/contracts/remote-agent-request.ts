/**
 * Strict plaintext contract carried inside an authenticated remote-control
 * `agent.request` command. This is intentionally a product-route allowlist,
 * not a general HTTP proxy: both the controller and target validate the same
 * request before any loopback fetch is possible.
 */

export const REMOTE_AGENT_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;
export const REMOTE_AGENT_RESPONSE_LIMIT_BYTES = 384 * 1024;
export const REMOTE_AGENT_CHAT_TIMEOUT_MS = 9 * 60_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_HEADERS = new Set([
  "accept",
  "content-type",
  "x-elizaos-client-id",
  "x-elizaos-ui-language",
  "x-elizaos-turn-attempt",
  "x-elizaos-turn-correlation",
]);
const CHAT_CHANNEL_TYPES = new Set([
  "DM",
  "GROUP",
  "VOICE_DM",
  "VOICE_GROUP",
  "API",
]);

export interface RemoteAgentRequest {
  path: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export type RemoteAgentRequestRoute =
  | "health"
  | "status"
  | "conversation-list"
  | "conversation-create"
  | "conversation-messages"
  | "conversation-message-stream";

function fail(message: string): never {
  throw new Error(`Remote agent request is invalid: ${message}.`);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    fail(`${label} contains an unsupported field`);
  }
}

function validateBoundedJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): void {
  state.nodes += 1;
  if (state.nodes > 1_024 || depth > 8) fail("metadata is too complex");
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    if (byteLength(value) > 16 * 1024) fail("metadata string is too large");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) fail("metadata array is too large");
    for (const entry of value) validateBoundedJson(entry, state, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) {
    fail("metadata contains a non-JSON value");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 256) fail("metadata object is too large");
  for (const [key, entry] of entries) {
    if (
      BLOCKED_OBJECT_KEYS.has(key) ||
      key.length === 0 ||
      byteLength(key) > 128
    ) {
      fail("metadata contains an unsafe key");
    }
    validateBoundedJson(entry, state, depth + 1);
  }
}

function validateMetadata(value: unknown): void {
  requireRecord(value, "metadata");
  validateBoundedJson(value, { nodes: 0 });
}

function parseJsonBody(body: string): Record<string, unknown> {
  if (byteLength(body) > REMOTE_AGENT_REQUEST_BODY_LIMIT_BYTES) {
    fail("body exceeds the byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail("body must be JSON");
  }
  return requireRecord(parsed, "body");
}

function validateCreateBody(body: string): void {
  const parsed = parseJsonBody(body);
  requireOnlyKeys(
    parsed,
    ["title", "includeGreeting", "lang", "metadata"],
    "conversation body",
  );
  if (
    parsed.title !== undefined &&
    (typeof parsed.title !== "string" || byteLength(parsed.title) > 1_024)
  ) {
    fail("conversation title is invalid");
  }
  if (
    parsed.includeGreeting !== undefined &&
    typeof parsed.includeGreeting !== "boolean"
  ) {
    fail("includeGreeting is invalid");
  }
  if (
    parsed.lang !== undefined &&
    (typeof parsed.lang !== "string" ||
      !/^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(parsed.lang))
  ) {
    fail("conversation language is invalid");
  }
  if (parsed.metadata !== undefined) validateMetadata(parsed.metadata);
}

function validateChatBody(body: string): void {
  const parsed = parseJsonBody(body);
  requireOnlyKeys(
    parsed,
    ["text", "channelType", "clientMessageId", "streamProtocol", "metadata"],
    "chat body",
  );
  if (
    typeof parsed.text !== "string" ||
    parsed.text.trim().length === 0 ||
    byteLength(parsed.text) > 128 * 1024
  ) {
    fail("chat text is invalid");
  }
  if (
    typeof parsed.channelType !== "string" ||
    !CHAT_CHANNEL_TYPES.has(parsed.channelType)
  ) {
    fail("chat channelType is invalid");
  }
  if (
    typeof parsed.clientMessageId !== "string" ||
    parsed.clientMessageId !== parsed.clientMessageId.trim() ||
    parsed.clientMessageId.length === 0 ||
    parsed.clientMessageId.length > 128 ||
    hasAsciiControl(parsed.clientMessageId)
  ) {
    fail("clientMessageId is invalid");
  }
  if (parsed.streamProtocol !== "delta-v2") {
    fail("streamProtocol is invalid");
  }
  if (parsed.metadata !== undefined) validateMetadata(parsed.metadata);
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const record = requireRecord(value, "headers");
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(record)) {
    const name = rawName.toLowerCase();
    if (
      rawName !== name ||
      !ALLOWED_HEADERS.has(name) ||
      typeof rawValue !== "string" ||
      rawValue.length === 0 ||
      byteLength(rawValue) > 512 ||
      hasAsciiControl(rawValue)
    ) {
      fail("headers contain an unsupported value");
    }
    normalized[name] = rawValue;
  }
  const contentType = normalized["content-type"];
  if (contentType !== undefined && contentType !== "application/json") {
    fail("content-type is unsupported");
  }
  const clientId = normalized["x-elizaos-client-id"];
  if (clientId !== undefined && !/^[A-Za-z0-9._-]{1,256}$/.test(clientId)) {
    fail("client id is invalid");
  }
  const language = normalized["x-elizaos-ui-language"];
  if (
    language !== undefined &&
    (language.length > 64 || hasAsciiControl(language))
  ) {
    fail("UI language is invalid");
  }
  const correlation = normalized["x-elizaos-turn-correlation"];
  if (correlation !== undefined && !UUID_PATTERN.test(correlation)) {
    fail("turn correlation is invalid");
  }
  const attempt = normalized["x-elizaos-turn-attempt"];
  if (attempt !== undefined && !/^(?:[1-9]|1[0-6])$/.test(attempt)) {
    fail("turn attempt is invalid");
  }
  return normalized;
}

function classifyMessagesPath(path: string): boolean {
  let url: URL;
  try {
    url = new URL(path, "http://remote.invalid");
  } catch {
    return false;
  }
  if (!/^\/api\/conversations\/[0-9a-f-]{36}\/messages$/i.test(url.pathname)) {
    return false;
  }
  const conversationId = url.pathname.split("/")[3];
  if (!UUID_PATTERN.test(conversationId ?? "")) return false;
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false;
  if (keys.some((key) => !["around", "before", "limit"].includes(key))) {
    return false;
  }
  const around = url.searchParams.get("around");
  const before = url.searchParams.get("before");
  const limit = url.searchParams.get("limit");
  if (around !== null) {
    return UUID_PATTERN.test(around) && before === null && limit === null;
  }
  if (before === null) return limit === null;
  if (!/^\d+$/.test(before)) return false;
  const beforeValue = Number(before);
  if (!Number.isSafeInteger(beforeValue) || beforeValue <= 0) return false;
  if (limit === null) return true;
  if (!/^\d+$/.test(limit)) return false;
  const limitValue = Number(limit);
  return (
    Number.isSafeInteger(limitValue) && limitValue >= 1 && limitValue <= 200
  );
}

export function classifyRemoteAgentRequestPath(
  path: string,
  method: "GET" | "POST",
): RemoteAgentRequestRoute | null {
  // Only origin-relative loopback paths are valid. `new URL(path, base)` also
  // accepts absolute and protocol-relative inputs, which must never reach the
  // native loopback fetch even if their pathname happens to match the
  // product-route allowlist. Fragments are likewise not part of an HTTP target
  // and would create an ambiguous signed request.
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    return null;
  }
  if (method === "GET" && path === "/api/health") return "health";
  if (method === "GET" && path === "/api/status") return "status";
  if (method === "GET" && path === "/api/conversations") {
    return "conversation-list";
  }
  if (method === "POST" && path === "/api/conversations") {
    return "conversation-create";
  }
  if (method === "GET" && classifyMessagesPath(path)) {
    return "conversation-messages";
  }
  if (
    method === "POST" &&
    /^\/api\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/messages\/stream$/i.test(
      path,
    )
  ) {
    return "conversation-message-stream";
  }
  return null;
}

/** Parse and copy the exact request admitted at both ends of the E2EE link. */
export function parseRemoteAgentRequest(value: unknown): RemoteAgentRequest {
  const record = requireRecord(value, "payload");
  requireOnlyKeys(record, ["path", "method", "headers", "body"], "payload");
  if (typeof record.path !== "string" || record.path.length > 2_048) {
    fail("path is invalid");
  }
  if (record.method !== "GET" && record.method !== "POST") {
    fail("method is unsupported");
  }
  const route = classifyRemoteAgentRequestPath(record.path, record.method);
  if (!route) fail("route is not allowlisted");
  const headers = normalizeHeaders(record.headers);
  const body = record.body;
  if (record.method === "GET") {
    if (body !== undefined) fail("GET body is not allowed");
  } else {
    if (typeof body !== "string") fail("POST body is required");
    if (headers["content-type"] !== "application/json") {
      fail("POST content-type is required");
    }
    if (route === "conversation-create") validateCreateBody(body);
    if (route === "conversation-message-stream") {
      if (headers.accept !== "text/event-stream") {
        fail("chat stream Accept header is required");
      }
      validateChatBody(body);
    }
  }
  return {
    path: record.path,
    method: record.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}
