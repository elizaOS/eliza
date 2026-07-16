/**
 * @elizaos/core Cloudflare Workers compatibility shim.
 *
 * The real package performs forbidden top-level I/O on Workers. Agent runtime
 * code runs on the Node sidecar (`services/agent-server`). This module keeps
 * Worker bundles resolvable, while runtime-only helpers throw if an accidental
 * Worker-side path reaches them.
 */

const NOT_AVAILABLE =
  "@elizaos/core runtime APIs are not available in the Cloudflare Workers API bundle. Route agent runtime work through the agent-server sidecar.";

function unavailable(name: string): never {
  throw new Error(`${name}: ${NOT_AVAILABLE}`);
}

function throwingExport(name: string): (...args: unknown[]) => never {
  return () => unavailable(name);
}

function readEnvValue(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

const DOCUMENT_AUGMENTATION_PREFIX =
  "Answer the user request using the contextual documents";
const USER_REQUEST_WRAPPER = /<user_request>\s*([\s\S]*?)\s*<\/user_request>/i;
const LANGUAGE_INSTRUCTION_SUFFIX = /\n*\[language instruction:[^\]]*\]\s*$/i;

function extractDocumentAugmentedUserText(raw: string): string {
  const match = raw.match(USER_REQUEST_WRAPPER);
  return (match?.[1] ?? raw).replace(LANGUAGE_INSTRUCTION_SUFFIX, "").trim();
}

export function hasDocumentAugmentationEnvelope(text: unknown): boolean {
  if (typeof text !== "string") return false;
  return text.trimStart().startsWith(DOCUMENT_AUGMENTATION_PREFIX);
}

export function stripAugmentationForPersistence<
  T extends { content?: unknown } | null | undefined,
>(message: T): T {
  const content = message?.content;
  if (!content || typeof content !== "object") return message;
  const rendered = (content as { text?: unknown }).text;
  if (!hasDocumentAugmentationEnvelope(rendered)) return message;
  const clean = extractDocumentAugmentedUserText(rendered as string);
  if (clean === rendered) return message;
  return {
    ...message,
    content: {
      ...(content as Record<string, unknown>),
      text: clean,
    },
  } as T;
}

// --- ElizaError: worker-safe mirror of @elizaos/core/errors (pure-JS Error
// subclass, no I/O). Cloud Worker services (active-billing-numeric, user-mcps,
// twap-price-oracle, cloudflare-registrar, …) import + extend it, so the shim
// must provide the real class, not a throwing stub. Mirrors packages/core/src/errors.ts. ---
export type ElizaErrorSeverity = "ephemeral" | "fatal";
export interface ElizaErrorOptions {
  code: string;
  cause?: unknown;
  context?: Record<string, unknown>;
  severity?: ElizaErrorSeverity;
}
export class ElizaError extends Error {
  override readonly name: string = "ElizaError";
  readonly code: string;
  readonly context?: Record<string, unknown>;
  readonly severity?: ElizaErrorSeverity;
  constructor(message: string, options: ElizaErrorOptions) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.code = options.code;
    this.context = options.context;
    this.severity = options.severity;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
export function isElizaError(value: unknown): value is ElizaError {
  return value instanceof ElizaError;
}
export function toElizaError(
  value: unknown,
  fallbackCode = "UNCLASSIFIED",
): ElizaError {
  if (value instanceof ElizaError) return value;
  if (value instanceof Error) {
    return new ElizaError(value.message, { code: fallbackCode, cause: value });
  }
  return new ElizaError(typeof value === "string" ? value : String(value), {
    code: fallbackCode,
    cause: value,
  });
}

/** Structural shape of a runtime that can resolve a per-agent setting. */
export interface SettingReader {
  getSetting(key: string): string | boolean | number | null | undefined;
}

export interface ResolveSettingOptions {
  defaultValue?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Worker-safe mirror of core's `resolveSetting` (utils/resolve-setting.ts):
 * per-agent runtime setting first, then env (trimmed; empty treated as unset),
 * then `options.defaultValue`. Coerces runtime values to string. No top-level I/O.
 */
export function resolveSetting(
  runtime: SettingReader | null | undefined,
  key: string,
  options: ResolveSettingOptions = {},
): string | undefined {
  const fromRuntime = runtime?.getSetting(key);
  if (fromRuntime !== undefined && fromRuntime !== null) {
    return String(fromRuntime);
  }
  return (
    readEnvValue(options.env ?? process.env, [key]) ?? options.defaultValue
  );
}

export function getElizaNamespace(
  env: Record<string, string | undefined> = process.env,
): string {
  return readEnvValue(env, ["ELIZA_NAMESPACE", "ELIZA_NAMESPACE"]) ?? "eliza";
}

export function resolveUserPath(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    const home = process.env.HOME?.trim() || "/tmp";
    return value === "~" ? home : `${home}/${value.slice(2)}`;
  }
  return value;
}

export function resolveStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = readEnvValue(env, ["ELIZA_STATE_DIR", "ELIZA_STATE_DIR"]);
  if (override) return resolveUserPath(override);
  const home = env.HOME?.trim() || process.env.HOME?.trim() || "/tmp";
  return `${home}/.${getElizaNamespace(env)}`;
}

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "y", "on", "enabled"]);

export function isTruthyEnvValue(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && TRUTHY_ENV_VALUES.has(normalized);
}

function presentEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

function buildAliasPartnerMap(
  aliases: readonly (readonly [string, string])[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    if (from === to) return;
    const existing = map.get(from);
    if (existing) {
      if (!existing.includes(to)) existing.push(to);
    } else {
      map.set(from, [to]);
    }
  };
  for (const [brandKey, elizaKey] of aliases) {
    link(brandKey, elizaKey);
    link(elizaKey, brandKey);
  }
  return map;
}

export function resolveAliasedEnvValue(
  key: string,
  aliases: readonly (readonly [string, string])[] | undefined = undefined,
  env: Record<string, string | undefined> | null = process.env,
): string | undefined {
  if (!env) return undefined;

  const direct = presentEnvValue(env[key]);
  if (direct !== undefined) return direct;
  if (!aliases || aliases.length === 0) return undefined;

  const partners = buildAliasPartnerMap(aliases).get(key);
  if (!partners) return undefined;
  for (const partner of partners) {
    const value = presentEnvValue(env[partner]);
    if (value !== undefined) return value;
  }
  return undefined;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    hex.push(bytes[index].toString(16).padStart(2, "0"));
  }

  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function utf8Encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha1Bytes(message: string): Uint8Array {
  const bytes = utf8Encode(message);
  const messageLength = bytes.length;
  const padded = new Uint8Array(((messageLength + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[messageLength] = 0x80;

  const dataView = new DataView(padded.buffer);
  const bitLength = messageLength * 8;
  dataView.setUint32(padded.length - 4, bitLength >>> 0, false);
  dataView.setUint32(
    padded.length - 8,
    Math.floor(bitLength / 2 ** 32) >>> 0,
    false,
  );

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = dataView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 80; index += 1) {
      const value =
        words[index - 3] ^
        words[index - 8] ^
        words[index - 14] ^
        words[index - 16];
      words[index] = (value << 1) | (value >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index += 1) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (((a << 5) | (a >>> 27)) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const output = new Uint8Array(20);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, h0, false);
  outputView.setUint32(4, h1, false);
  outputView.setUint32(8, h2, false);
  outputView.setUint32(12, h3, false);
  outputView.setUint32(16, h4, false);
  return output;
}

export function stringToUuid(target: string | number): string {
  const value = typeof target === "number" ? target.toString() : target;
  if (typeof value !== "string") {
    throw new TypeError("Value must be string");
  }

  if (UUID_RE.test(value)) {
    return value;
  }

  const bytes = sha1Bytes(encodeURIComponent(value)).slice(0, 16);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  bytes[6] = bytes[6] & 0x0f;
  return bytesToUuid(bytes);
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asUUID(value: string): string {
  if (!value || !UUID_RE.test(value)) {
    throw new Error(`Invalid UUID format: ${value}`);
  }
  return value;
}

export function createUniqueUuid(
  runtime: { agentId?: string } | null | undefined,
  baseUserId: string,
): string {
  if (runtime?.agentId && baseUserId === runtime.agentId) {
    return runtime.agentId;
  }

  return stringToUuid(`${baseUserId}:${runtime?.agentId ?? ""}`);
}

const workerLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  success: () => {},
  child: () => workerLogger,
};

export const logger = workerLogger;
export const elizaLogger = workerLogger;

export const DEFAULT_CEREBRAS_TEXT_MODEL = "gemma-4-31b";
export const DEFAULT_ELIZA_CLOUD_TEXT_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;
export const DEFAULT_ELIZA_CLOUD_LARGE_TEXT_MODEL = "zai-glm-4.7";
export const DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/**
 * Worker-safe stand-in for `runWithTrajectoryContext`. The trajectory context
 * manager lives on the agent sidecar; in the Worker bundle there is nothing to
 * track, so just run the function. (Pulled into the bundle transitively via
 * `@elizaos/shared` email-classification — not invoked on a Worker route.)
 */
export function runWithTrajectoryContext<T>(
  _context: unknown,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return fn();
}

/**
 * Worker-safe pass-through for core's `runWithTrajectoryPurpose`. The Worker
 * build has no AsyncLocalStorage trajectory-context manager (node-only), so
 * trajectory-purpose tracking is a no-op here. Pulled into the bundle via
 * `@elizaos/shared` email-classification (#11580) — not invoked on a Worker
 * route, but the export must exist for the bundle to link.
 */
export function runWithTrajectoryPurpose<T>(
  _purpose: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return fn();
}

// ---------------------------------------------------------------------------
// fetchWithSsrfGuard — Worker-safe port of @elizaos/core/network/fetch-guard.
//
// Pulled into the bundle via plugin-elizacloud transcription (`audioUrl`
// fetch). workerd has no `node:dns`, so the core guard's DNS pinning is not
// portable; everything else is reproduced: http(s)-only, blocked-hostname +
// private/loopback/link-local literal-IP rejection, manual redirect following
// with re-validation on every hop, credential-header stripping on
// cross-origin hops, spec-correct 301/302/303 GET rewrites, and timeout
// wiring. Fail-closed: a URL this port cannot positively clear is rejected.
// ---------------------------------------------------------------------------

/** Mirrors core's `SsrfBlockedError` for callers that match on `name`. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export type GuardedFetchOptions = {
  url: string;
  fetchImpl?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  init?: RequestInit;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

const SSRF_BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);
const SSRF_BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

function isPrivateIpv4(hostname: string): boolean {
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return true; // malformed literal — reject
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || // 192.0.0.0/24 special + 192.0.2.0/24 doc
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved + broadcast
  );
}

function isBlockedIpLiteral(hostname: string): boolean {
  if (isPrivateIpv4(hostname)) return true;
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false; // not an IPv6 literal
  if (h === "::" || h === "::1") return true;
  if (
    h.startsWith("fe80:") ||
    h.startsWith("fe9") ||
    h.startsWith("fea") ||
    h.startsWith("feb")
  )
    return true; // link-local fe80::/10
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  if (h.startsWith("ff")) return true; // multicast
  // v4-mapped: dotted form (::ffff:127.0.0.1) or the canonical hex form the
  // WHATWG URL parser serializes it to (::ffff:7f00:1).
  const v4MappedDotted = h.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (v4MappedDotted?.[1]) return isPrivateIpv4(v4MappedDotted[1]);
  const v4MappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex?.[1] && v4MappedHex[2]) {
    const hi = Number.parseInt(v4MappedHex[1], 16);
    const lo = Number.parseInt(v4MappedHex[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  return false;
}

function assertSsrfAllowedUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(
      `Blocked non-http(s) URL scheme: ${url.protocol}`,
    );
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) {
    throw new SsrfBlockedError("Blocked URL with empty hostname");
  }
  if (SSRF_BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(`Blocked hostname: ${host}`);
  }
  if (SSRF_BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new SsrfBlockedError(`Blocked internal hostname: ${host}`);
  }
  if (isBlockedIpLiteral(host)) {
    throw new SsrfBlockedError(`Blocked private/reserved IP literal: ${host}`);
  }
}

const SSRF_CROSS_ORIGIN_STRIPPED_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
];
const SSRF_REDIRECT_BODY_STRIPPED_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
];

function stripHeaders(
  headers: HeadersInit | undefined,
  names: string[],
): Headers {
  const cleaned = new Headers(headers);
  for (const name of names) cleaned.delete(name);
  return cleaned;
}

function combineAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

export async function fetchWithSsrfGuard(
  options: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutSignal =
    options.timeoutMs !== undefined
      ? AbortSignal.timeout(options.timeoutMs)
      : undefined;
  const signal = combineAbortSignals(options.signal, timeoutSignal);

  let current = new URL(options.url);
  let method = (options.init?.method ?? "GET").toUpperCase();
  let body = options.init?.body;
  let headers = new Headers(options.init?.headers);

  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertSsrfAllowedUrl(current);
    const response = await fetchImpl(current.toString(), {
      ...options.init,
      method,
      body,
      headers,
      redirect: "manual",
      signal,
    });

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current);
      try {
        if (!response.bodyUsed) await response.body?.cancel();
      } catch {
        // redirect body already settled — nothing to release
      }
      // Spec redirect rewrite: 301/302 POST→GET, 303 anything-but-GET/HEAD→GET.
      if (
        ((response.status === 301 || response.status === 302) &&
          method === "POST") ||
        (response.status === 303 && method !== "GET" && method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
        headers = stripHeaders(headers, SSRF_REDIRECT_BODY_STRIPPED_HEADERS);
      }
      if (next.origin !== current.origin) {
        headers = stripHeaders(headers, SSRF_CROSS_ORIGIN_STRIPPED_HEADERS);
      }
      current = next;
      continue;
    }

    return {
      response,
      finalUrl: current.toString(),
      release: async () => {
        try {
          if (!response.bodyUsed) await response.body?.cancel();
        } catch {
          // body already consumed/locked — nothing to release
        }
      },
    };
  }
  throw new SsrfBlockedError(
    `Exceeded ${maxRedirects} redirects fetching ${options.url}`,
  );
}

type InferenceTimingMeta = Record<string, string | number | boolean>;

/**
 * Worker-safe `timeInferenceSpan`: in @elizaos/core this records a span on the
 * active turn timer, but the timing context manager lives on the agent sidecar.
 * No timer is ever active in the Worker bundle, so just run `fn` (matching the
 * core no-op-when-no-timer path). Pulled in transitively via plugin-elizacloud.
 */
export async function timeInferenceSpan<T>(
  _name: string,
  fn: () => Promise<T>,
  _meta?: InferenceTimingMeta,
): Promise<T> {
  return fn();
}

/** Worker-safe `recordInferenceSpan`: no active timer in the Worker, so no-op. */
export function recordInferenceSpan(
  _name: string,
  _durationMs: number,
  _meta?: InferenceTimingMeta,
): void {}

/**
 * Worker-safe `parseJsonModelRecord`: mirrors @elizaos/core — strip a leading
 * `<think>…</think>` block and a fenced code block, JSON.parse, and accept only
 * a plain (non-array) object. Pure string work, safe in workerd.
 */
export function parseJsonModelRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(raw: string): T | null {
  let candidate = raw.trim();
  const thinkEnd = candidate.indexOf("</think>");
  if (candidate.startsWith("<think>") && thinkEnd !== -1) {
    candidate = candidate.slice(thinkEnd + "</think>".length).trim();
  }
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = (fenced[1] ?? "").trim();
  if (candidate.length === 0) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export async function readRequestBodyBuffer(
  request: Request,
  { maxBytes = DEFAULT_MAX_BODY_BYTES }: { maxBytes?: number } = {},
): Promise<Buffer | null> {
  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength > maxBytes) {
    throw new Error(`Request body exceeds maximum size (${maxBytes} bytes)`);
  }
  return body;
}

export async function readRequestBody(
  request: Request,
  options: { maxBytes?: number; encoding?: BufferEncoding } = {},
): Promise<string | null> {
  const body = await readRequestBodyBuffer(request, options);
  return body?.toString(options.encoding ?? "utf-8") ?? null;
}

export async function readJsonBody<T = Record<string, unknown>>(
  request: Request,
  _response?: unknown,
  options: { maxBytes?: number; requireObject?: boolean } = {},
): Promise<T | null> {
  const raw = await readRequestBody(request, options);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (
    options.requireObject !== false &&
    (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    return null;
  }
  return parsed as T;
}

export function sendJson(
  _response: unknown,
  body: unknown,
  status = 200,
): Response {
  return Response.json(body, { status });
}

export function sendJsonError(
  _response: unknown,
  message: string,
  status = 400,
): Response {
  return Response.json({ error: message }, { status });
}

const CONNECTOR_SOURCE_ALIASES: Record<string, readonly string[]> = {
  discord: ["discord", "discord-local"],
  imessage: ["imessage", "bluebubbles"],
  signal: ["signal"],
  slack: ["slack"],
  sms: ["sms"],
  telegram: ["telegram", "telegram-account", "telegramaccount"],
  wechat: ["wechat"],
  whatsapp: ["whatsapp"],
};

export type ConnectorSourceKind = "passive" | "active";

export interface ConnectorIdentityMetadataMapping {
  userIdField: string;
  nameField?: string;
}

export interface ConnectorSourceMetadata {
  aliases?: readonly string[];
  sourceKind?: ConnectorSourceKind;
  isPassive?: boolean;
  identityMetadataMapping?: ConnectorIdentityMetadataMapping;
  worldIdMetadataKeys?: readonly string[];
}

export interface ConnectorSourceDefinition extends ConnectorSourceMetadata {
  source: string;
}

const DEFAULT_CONNECTOR_SOURCE_OWNER = "manual";
const registeredMetadataByOwner = new Map<
  string,
  Map<string, ConnectorSourceMetadata>
>();

function mergeConnectorSourceMetadata(
  base: ConnectorSourceMetadata | undefined,
  registered: ConnectorSourceMetadata | undefined,
): ConnectorSourceMetadata {
  return {
    aliases: Array.from(
      new Set([...(base?.aliases ?? []), ...(registered?.aliases ?? [])]),
    ),
    sourceKind: registered?.sourceKind ?? base?.sourceKind,
    isPassive: registered?.isPassive ?? base?.isPassive,
    identityMetadataMapping:
      registered?.identityMetadataMapping ?? base?.identityMetadataMapping,
    worldIdMetadataKeys:
      registered?.worldIdMetadataKeys ?? base?.worldIdMetadataKeys,
  };
}

function listRegisteredCanonicalSources(): string[] {
  const sources = new Set<string>();
  for (const ownerMetadata of registeredMetadataByOwner.values()) {
    for (const canonical of ownerMetadata.keys()) sources.add(canonical);
  }
  return [...sources];
}

function getMergedConnectorSourceMetadata(
  canonical: string,
): ConnectorSourceMetadata {
  let merged: ConnectorSourceMetadata | undefined;
  for (const ownerMetadata of registeredMetadataByOwner.values()) {
    merged = mergeConnectorSourceMetadata(merged, ownerMetadata.get(canonical));
  }
  return merged ?? {};
}

function getMergedConnectorSourceAliases(canonical: string): readonly string[] {
  return getMergedConnectorSourceMetadata(canonical).aliases ?? [];
}

export function registerConnectorSourceMetadata(
  canonical: string,
  metadata: ConnectorSourceMetadata,
  owner = DEFAULT_CONNECTOR_SOURCE_OWNER,
): void {
  const key = canonical.trim().toLowerCase();
  if (!key) return;

  const ownerKey = owner.trim() || DEFAULT_CONNECTOR_SOURCE_OWNER;
  let ownerMetadata = registeredMetadataByOwner.get(ownerKey);
  if (!ownerMetadata) {
    ownerMetadata = new Map();
    registeredMetadataByOwner.set(ownerKey, ownerMetadata);
  }

  const existing = ownerMetadata.get(key);
  const mergedAliases = new Set([
    key,
    ...(existing?.aliases ?? []),
    ...(metadata.aliases ?? []).map((alias) => alias.trim().toLowerCase()),
  ]);
  ownerMetadata.set(key, {
    ...existing,
    ...metadata,
    aliases: Array.from(mergedAliases).filter(Boolean),
  });
}

export function registerConnectorSourceDefinitions(
  definitions: readonly ConnectorSourceDefinition[] | null | undefined,
  owner = DEFAULT_CONNECTOR_SOURCE_OWNER,
): void {
  for (const definition of definitions ?? []) {
    const { source, ...metadata } = definition;
    registerConnectorSourceMetadata(source, metadata, owner);
  }
}

export function unregisterConnectorSourceMetadataOwner(owner: string): void {
  const ownerKey = owner.trim();
  if (!ownerKey) return;
  registeredMetadataByOwner.delete(ownerKey);
}

export function registerConnectorSourceAliases(
  canonical: string,
  aliases: readonly string[],
): void {
  registerConnectorSourceMetadata(canonical, { aliases });
}

export function normalizeConnectorSource(
  source: string | null | undefined,
): string {
  if (typeof source !== "string") return "";
  const trimmed = source.trim().toLowerCase();
  if (!trimmed) return "";
  for (const [canonical, aliases] of Object.entries(CONNECTOR_SOURCE_ALIASES)) {
    if (aliases.includes(trimmed)) return canonical;
  }
  for (const canonical of listRegisteredCanonicalSources()) {
    if (getMergedConnectorSourceAliases(canonical).includes(trimmed)) {
      return canonical;
    }
  }
  return trimmed;
}

export function getConnectorSourceAliases(
  source: string | null | undefined,
): string[] {
  const canonical = normalizeConnectorSource(source);
  if (!canonical) return [];
  return Array.from(
    new Set([
      ...(CONNECTOR_SOURCE_ALIASES[canonical] ?? [canonical]),
      ...getMergedConnectorSourceAliases(canonical),
    ]),
  );
}

export function getConnectorSourceMetadata(
  source: string | null | undefined,
): ConnectorSourceMetadata | null {
  const canonical = normalizeConnectorSource(source);
  if (!canonical) return null;
  const metadata = getMergedConnectorSourceMetadata(canonical);
  return Object.keys(metadata).length > 0 ? metadata : null;
}

export function isPassiveConnectorSource(
  source: string | null | undefined,
): boolean {
  const metadata = getConnectorSourceMetadata(source);
  return Boolean(metadata?.isPassive || metadata?.sourceKind === "passive");
}

export function getConnectorIdentityMetadataMapping(
  source: string | null | undefined,
): ConnectorIdentityMetadataMapping | null {
  const mapping = getConnectorSourceMetadata(source)?.identityMetadataMapping;
  if (!mapping || typeof mapping.userIdField !== "string") return null;
  const userIdField = mapping.userIdField.trim();
  if (!userIdField) return null;
  const nameField =
    typeof mapping.nameField === "string" && mapping.nameField.trim()
      ? mapping.nameField.trim()
      : undefined;
  return { userIdField, ...(nameField ? { nameField } : {}) };
}

export function getConnectorWorldIdMetadataKeys(
  source: string | null | undefined,
): string[] {
  const keys = getConnectorSourceMetadata(source)?.worldIdMetadataKeys;
  if (!Array.isArray(keys)) return [];
  return keys
    .filter((key): key is string => typeof key === "string")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function expandConnectorSourceFilter(
  sources: Iterable<string> | null | undefined,
): Set<string> {
  const expanded = new Set<string>();
  for (const source of sources ?? []) {
    for (const alias of getConnectorSourceAliases(source)) {
      expanded.add(alias);
    }
  }
  return expanded;
}

registerConnectorSourceMetadata(
  "discord",
  {
    identityMetadataMapping: {
      userIdField: "fromId",
      nameField: "entityName",
    },
    worldIdMetadataKeys: ["discordServerId", "discordChannelId"],
  },
  "core:legacy-discord-metadata",
);

export function getRecentMessagesData(state: unknown): unknown[] {
  const providers = (
    state as { data?: { providers?: Record<string, unknown> } }
  )?.data?.providers;
  const recentProvider = providers?.RECENT_MESSAGES as
    | { data?: { recentMessages?: unknown } }
    | undefined;
  const messages = recentProvider?.data?.recentMessages;
  return Array.isArray(messages) ? messages : [];
}

export function isWechatConfigured(
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (!config || config.enabled === false) return false;
  if (config.apiKey) return true;
  const accounts = config.accounts;
  return Boolean(
    accounts &&
      typeof accounts === "object" &&
      Object.values(accounts as Record<string, Record<string, unknown>>).some(
        (account) =>
          account && account.enabled !== false && Boolean(account.apiKey),
      ),
  );
}

export function isConnectorConfigured(
  connectorName: string,
  connectorConfig: unknown,
): boolean {
  if (!connectorConfig || typeof connectorConfig !== "object") return false;
  const config = connectorConfig as Record<string, unknown>;
  if (config.enabled === false) return false;
  if (config.botToken || config.token || config.apiKey) return true;
  if (connectorName === "wechat") return isWechatConfigured(config);
  return Boolean(config.enabled === true);
}

export function isStreamingDestinationConfigured(
  _destName: string,
  destConfig: unknown,
): boolean {
  if (!destConfig || typeof destConfig !== "object") return false;
  const config = destConfig as Record<string, unknown>;
  if (config.enabled === false) return false;
  return Boolean(config.enabled === true || config.streamKey || config.rtmpUrl);
}

export const ContentType = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  DOCUMENT: "document",
  LINK: "link",
} as const;

export const EventType = {
  MESSAGE_RECEIVED: "MESSAGE_RECEIVED",
  MESSAGE_SENT: "MESSAGE_SENT",
  ACTION_STARTED: "ACTION_STARTED",
  ACTION_COMPLETED: "ACTION_COMPLETED",
  WORLD_JOINED: "WORLD_JOINED",
  ROOM_JOINED: "ROOM_JOINED",
  ENTITY_JOINED: "ENTITY_JOINED",
  USER_JOINED: "USER_JOINED",
  RUN_STARTED: "RUN_STARTED",
  RUN_ENDED: "RUN_ENDED",
  RUN_TIMEOUT: "RUN_TIMEOUT",
  MODEL_USED: "MODEL_USED",
} as const;

export const ChannelType = {
  DM: "DM",
  GROUP: "GROUP",
  VOICE_DM: "VOICE_DM",
  VOICE_GROUP: "VOICE_GROUP",
  FEED: "FEED",
  THREAD: "THREAD",
  WORLD: "WORLD",
  FORUM: "FORUM",
  API: "API",
  SELF: "SELF",
} as const;

type SensitiveRequestKind = "secret" | "payment" | "oauth" | "private_info";
type SensitiveRequestPaymentContext = "verified_payer" | "any_payer";

export function defaultSensitiveRequestPolicy(
  kind: SensitiveRequestKind,
  paymentContext: SensitiveRequestPaymentContext = "verified_payer",
) {
  if (kind === "payment" && paymentContext === "any_payer") {
    return {
      actor: "any_payer",
      requirePrivateDelivery: false,
      requireAuthenticatedLink: false,
      allowInlineOwnerAppEntry: true,
      allowPublicLink: true,
      allowDmFallback: true,
      allowTunnelLink: true,
      allowCloudLink: true,
    };
  }

  if (kind === "payment") {
    return {
      actor: "verified_payer",
      requirePrivateDelivery: false,
      requireAuthenticatedLink: true,
      allowInlineOwnerAppEntry: true,
      allowPublicLink: true,
      allowDmFallback: true,
      allowTunnelLink: true,
      allowCloudLink: true,
    };
  }

  if (kind === "oauth") {
    return {
      actor: "owner_or_linked_identity",
      requirePrivateDelivery: false,
      requireAuthenticatedLink: true,
      allowInlineOwnerAppEntry: true,
      allowPublicLink: true,
      allowDmFallback: true,
      allowTunnelLink: true,
      allowCloudLink: true,
    };
  }

  return {
    actor: "owner_or_linked_identity",
    requirePrivateDelivery: true,
    requireAuthenticatedLink: true,
    allowInlineOwnerAppEntry: true,
    allowPublicLink: false,
    allowDmFallback: true,
    allowTunnelLink: true,
    allowCloudLink: true,
  };
}

const SENSITIVE_METADATA_KEY_RE =
  /(^|[_-])(authorization|bearer|credential|jwt|password|private|secret|signature|token)([_-]|$)|api[_-]?key/i;

export function redactSensitiveRequestMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveRequestMetadata(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_METADATA_KEY_RE.test(key)
      ? "[redacted]"
      : redactSensitiveRequestMetadata(item);
  }
  return redacted;
}

// PII scrub primitives consumed by the cloud-shared CLOUD-lane job rails
// (#14808, `lib/services/pii-scrub-executor.ts`). Re-exported from the REAL
// core modules — `security/pii-detectors.ts` (pure regex + noble hashes) and
// `security/pii-scrub-seam.ts`'s validators (pure checks over type-only
// runtime imports) are Worker-safe leaves, and single-sourcing them here
// keeps the cloud lane's tier-0 floor and fail-closed contract in lockstep
// with the LOCAL lane instead of drifting behind core's.
export {
  detectPii,
  type PiiMatch,
} from "../../../../core/src/security/pii-detectors";
export {
  assertValidScrubResult,
  PiiScrubFabricationError,
} from "../../../../core/src/security/pii-scrub-seam";
// Log-redaction helpers consumed by the cloud-shared Worker logger on every
// log call. Re-exported from the REAL core module — `security/redact.ts` is a
// zero-import pure leaf, so it is Worker-safe, and single-sourcing it here
// keeps Worker-side secret masking from drifting behind core's.
export {
  isSensitiveKeyName,
  redactLogArgs,
} from "../../../../core/src/security/redact";
export type { PiiScrubResult } from "../../../../core/src/types/model";

export const ModelType = {
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_LARGE: "TEXT_LARGE",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
  TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",
  TEXT_REASONING_SMALL: "TEXT_REASONING_SMALL",
  TEXT_REASONING_LARGE: "TEXT_REASONING_LARGE",
  IMAGE: "IMAGE",
  IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
  TRANSCRIPTION: "TRANSCRIPTION",
  TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
  AUDIO: "AUDIO",
  VIDEO: "VIDEO",
  OBJECT_SMALL: "OBJECT_SMALL",
  OBJECT_LARGE: "OBJECT_LARGE",
} as const;

export const ServiceType = {
  TRANSCRIPTION: "TRANSCRIPTION",
  VIDEO: "VIDEO",
  BROWSER: "BROWSER",
  PDF: "PDF",
  REMOTE_FILES: "REMOTE_FILES",
  MEDIA_GENERATION: "MEDIA_GENERATION",
  CLOUD_AUTH: "CLOUD_AUTH",
} as const;

// Mirrors core's `CLOUD_AUTH_SERVICE_TYPE = ServiceType.CLOUD_AUTH`. Imported
// by plugin-elizacloud's cloud-auth service, which the Worker bundles for its
// shared constants; the sidecar owns the actual service registration.
export const CLOUD_AUTH_SERVICE_TYPE = ServiceType.CLOUD_AUTH;

export const VECTOR_DIMS = {
  SMALL: 384,
  MEDIUM: 512,
  LARGE: 768,
  XL: 1024,
  XXL: 1536,
  XXXL: 3072,
} as const;

export const MemoryType = {
  DOCUMENT: "document",
  FRAGMENT: "fragment",
  MESSAGE: "message",
  DESCRIPTION: "description",
  CUSTOM: "custom",
} as const;

export const documentsPluginCore = {
  name: "documents",
  description:
    "Cloud Worker compatibility surface for the documents runtime plugin.",
  actions: [],
  providers: [],
  services: [],
};

export const addHeader = (header: string, body: string) =>
  body ? `${header}\n${body}` : "";

export const UUID = (value?: string): string => asUUID(value ?? "");
export const composeActionExamples = throwingExport("composeActionExamples");
export const formatActions = throwingExport("formatActions");
export const formatActionNames = throwingExport("formatActionNames");
export const composePromptFromState = throwingExport("composePromptFromState");
export const composePrompt = throwingExport("composePrompt");
export const parseJSONObjectFromText = throwingExport(
  "parseJSONObjectFromText",
);
export const generateText = throwingExport("generateText");
export const generateObject = throwingExport("generateObject");
export const getTokenForProvider = throwingExport("getTokenForProvider");
export const trimTokens = throwingExport("trimTokens");
export const truncateToCompleteSentence = throwingExport(
  "truncateToCompleteSentence",
);
export const parseKeyValueXml = throwingExport("parseKeyValueXml");
export const parseBooleanFromText = throwingExport("parseBooleanFromText");
export const parseCharacter = throwingExport("parseCharacter");
export const formatMessages = throwingExport("formatMessages");
export const formatPosts = throwingExport("formatPosts");
export const getEntityDetails = throwingExport("getEntityDetails");
export const splitChunks = throwingExport("splitChunks");
export const createMessageMemory = throwingExport("createMessageMemory");
export const executePlannedToolCall = throwingExport("executePlannedToolCall");

/**
 * Host-bridge setters (core `account-pool-bridge.ts`). The real
 * implementations write to a host-app global slot that nothing in the Worker
 * ever reads, and they already no-op when the slot is absent — so faithful
 * Worker stand-ins are no-ops, not throws (app-core service modules install
 * these bridges at import time).
 */
export function setAnthropicAccountPoolBridge(_bridge: unknown): void {}
export function setCodingAgentSelectorBridge(_bridge: unknown): void {}

/**
 * Subscription-auth provider registry (core `features/subscription-auth`).
 * `@elizaos/auth` registers built-in descriptors at module init, so the
 * Worker needs a real (tiny) registry, not a throwing stand-in. Semantics
 * mirror core: last registration per id wins.
 */
const subscriptionAuthProviders = new Map<string, { id: string }>();

export function registerSubscriptionAuthProvider(provider: {
  id: string;
}): void {
  subscriptionAuthProviders.set(provider.id, provider);
}

export function getSubscriptionAuthProvider(
  id: string,
): { id: string } | undefined {
  return subscriptionAuthProviders.get(id);
}

export function hasSubscriptionAuthProvider(id: string): boolean {
  return subscriptionAuthProviders.has(id);
}

function renderSystemPromptBio(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .join(" ");
}

function textFromChatMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildCanonicalSystemPrompt(args: {
  character?: { name?: unknown; system?: unknown; bio?: unknown } | null;
  userRole?: unknown;
}): string {
  const character = args.character;
  const system =
    typeof character?.system === "string" ? character.system.trim() : "";
  const bio = renderSystemPromptBio(character?.bio);
  const name =
    typeof character?.name === "string" && character.name.trim()
      ? character.name.trim()
      : "the agent";
  const role =
    typeof args.userRole === "string" ? args.userRole.trim().toUpperCase() : "";
  return [
    system,
    bio ? `# About ${name}\n${bio}` : "",
    role ? `user_role: ${role}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function resolveEffectiveSystemPrompt(args: {
  params?: unknown;
  fallback?: string | null;
}): string | undefined {
  const params =
    args.params &&
    typeof args.params === "object" &&
    !Array.isArray(args.params)
      ? (args.params as Record<string, unknown>)
      : null;
  if (params && Object.hasOwn(params, "system")) {
    return typeof params.system === "string"
      ? params.system.trim() || undefined
      : undefined;
  }
  const messages = params?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    const first = messages[0] as { role?: unknown; content?: unknown };
    if (first?.role === "system") {
      const system = textFromChatMessageContent(first.content);
      if (system) return system;
    }
  }
  const fallback =
    typeof args.fallback === "string" ? args.fallback.trim() : "";
  return fallback || undefined;
}

export function renderChatMessagesForPrompt(
  messages: Array<{ role?: unknown; content?: unknown }> | undefined,
  options: { omitDuplicateSystem?: string } = {},
): string {
  if (!Array.isArray(messages)) return "";
  const omitDuplicateSystem = options.omitDuplicateSystem?.trim();
  return messages
    .filter((message, index) => {
      if (index !== 0 || !omitDuplicateSystem || message?.role !== "system")
        return true;
      return (
        textFromChatMessageContent(message.content) !== omitDuplicateSystem
      );
    })
    .map((message) => {
      const role = typeof message?.role === "string" ? message.role : "user";
      const content = textFromChatMessageContent(message?.content);
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function getRequestContext(): undefined {
  return undefined;
}

export function toRuntimeSettings(runtime: unknown): Record<string, unknown> {
  if (!runtime || typeof runtime !== "object") return {};
  const candidate = runtime as {
    settings?: unknown;
    character?: { settings?: unknown };
  };
  const settings =
    candidate.settings ??
    candidate.character?.settings ??
    (runtime as Record<string, unknown>);
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>)
    : {};
}

export function isCloudInferenceSelectedInConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  const cloud = config?.cloud;
  if (!cloud || typeof cloud !== "object" || Array.isArray(cloud)) {
    return false;
  }
  const record = cloud as Record<string, unknown>;
  return record.enabled === true || typeof record.apiKey === "string";
}

export const isElizaCloudServiceSelectedInConfig =
  isCloudInferenceSelectedInConfig;

export function isCloudConnected(settings: Record<string, unknown>): boolean {
  return isCloudInferenceSelectedInConfig(settings);
}

export function migrateLegacyRuntimeConfig(
  _config: Record<string, unknown> | null | undefined,
): void {}

export function isElizaSettingsDebugEnabled(): boolean {
  return false;
}

export function settingsDebugCloudSummary(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const cloud =
    config?.cloud && typeof config.cloud === "object"
      ? (config.cloud as Record<string, unknown>)
      : {};
  return {
    enabled: cloud.enabled === true,
    hasApiKey: typeof cloud.apiKey === "string" && cloud.apiKey.length > 0,
  };
}

// Settings-debug is disabled in the Worker (isElizaSettingsDebugEnabled → false),
// so this only satisfies @elizaos/shared's import; keep it non-leaking rather than
// a faithful deep-sanitize (never reached on the workerd path).
export function sanitizeForSettingsDebug(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "object") return "[object]";
  if (typeof value === "string") return value.length > 8 ? "[redacted]" : value;
  return value;
}

// Faithful mirrors of @elizaos/core name-token substitution: these ARE reached on
// the Worker prompt path, so behavior must match core exactly. A replacer function
// (not the raw name string) keeps `$`-sequences in a name literal.
export function replaceNameTokens(text: string, name: string): string {
  if (!text) return text;
  return text
    .replace(/\{\{\s*name\s*\}\}/g, () => name)
    .replace(/\{\{\s*agentName\s*\}\}/g, () => name);
}

export function replaceIndexedNameTokens(
  text: string,
  names: readonly string[],
): string {
  if (!text) return text;
  return text.replace(
    /\{\{\s*(?:name|user)(\d+)\s*\}\}/g,
    (match, slot: string) => {
      const name = names[Number(slot) - 1];
      return name === undefined ? match : name;
    },
  );
}

export function sanitizeSpeechText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getRuntimeRouteHostContext<T = Record<string, unknown>>(
  runtime: unknown,
): T | undefined {
  if (!runtime || typeof runtime !== "object") return undefined;
  const candidate = runtime as { routeHostContext?: T; hostContext?: T };
  return candidate.routeHostContext ?? candidate.hostContext;
}

export function registerAppRoutePluginLoader(
  _id: string,
  _loader: () => Promise<unknown>,
): void {}

export function resolveDesktopApiPort(
  env: Record<string, string | undefined> = process.env,
): number {
  return Number.parseInt(
    env.ELIZA_API_PORT ?? env.API_PORT ?? env.SERVER_PORT ?? "2138",
    10,
  );
}

export function resolveApiSecurityConfig(
  env: Record<string, string | undefined> = process.env,
): { bindHost: string; isLoopbackBind: boolean } {
  const bindHost = env.ELIZA_API_BIND ?? env.API_HOST ?? "127.0.0.1";
  return {
    bindHost,
    isLoopbackBind:
      bindHost === "127.0.0.1" ||
      bindHost === "localhost" ||
      bindHost === "::1",
  };
}

export class Service {
  protected runtime: unknown;

  constructor(runtime?: unknown) {
    this.runtime = runtime;
  }

  static start(..._args: unknown[]): never {
    unavailable("Service.start");
  }

  async stop(): Promise<void> {}
}

export class IMediaGenerationService extends Service {
  static readonly serviceType = ServiceType.MEDIA_GENERATION;
  readonly capabilityDescription = "Generates media from prompts.";

  async generateMedia(..._args: unknown[]): Promise<never> {
    unavailable("IMediaGenerationService.generateMedia");
  }
}

export class AgentRuntime {
  constructor(..._args: unknown[]) {
    unavailable("AgentRuntime");
  }
}

export class DefaultMessageService {
  constructor(..._args: unknown[]) {
    unavailable("DefaultMessageService");
  }
}

export class Semaphore {
  constructor(_max: number = 1) {
    unavailable("Semaphore");
  }

  async acquire(): Promise<never> {
    unavailable("Semaphore.acquire");
  }

  release(): never {
    unavailable("Semaphore.release");
  }
}

export class BM25 {
  constructor(..._args: unknown[]) {
    unavailable("BM25");
  }

  search(..._args: unknown[]): never {
    unavailable("BM25.search");
  }
}

export type IAgentRuntime = unknown;
export type Plugin = unknown;
export type Action = unknown;
export type Provider = unknown;
export type Evaluator = unknown;
export type Memory = unknown;
export type Entity = unknown;
export type Participant = unknown;
export type Room = unknown;
export type World = unknown;
export type Media = { url?: string; contentType?: string };
export type State = unknown;
export type MessagePayload = unknown;
export type HandlerCallback = (...args: unknown[]) => unknown;
export type Character = unknown;
export type Component = unknown;
export type Task = unknown;
export type ActionExample = unknown;
export type Content = unknown;
export type ImageGenerationResult = unknown;
export type MediaGenerationRequest = {
  mediaType: string;
  prompt: string;
  size?: string;
};
export type MediaGenerationResponse = Record<string, unknown>;

export default {
  logger,
  elizaLogger,
  DEFAULT_CEREBRAS_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
  ContentType,
  EventType,
  ChannelType,
  ModelType,
  ServiceType,
  VECTOR_DIMS,
  MemoryType,
  documentsPluginCore,
  addHeader,
  UUID,
  composeActionExamples,
  formatActions,
  formatActionNames,
  composePrompt,
  composePromptFromState,
  parseJSONObjectFromText,
  generateText,
  generateObject,
  stringToUuid,
  getTokenForProvider,
  trimTokens,
  truncateToCompleteSentence,
  parseKeyValueXml,
  parseBooleanFromText,
  parseCharacter,
  formatMessages,
  formatPosts,
  getEntityDetails,
  createUniqueUuid,
  asUUID,
  splitChunks,
  createMessageMemory,
  executePlannedToolCall,
  buildCanonicalSystemPrompt,
  resolveEffectiveSystemPrompt,
  renderChatMessagesForPrompt,
  getRequestContext,
  toRuntimeSettings,
  isCloudInferenceSelectedInConfig,
  isElizaCloudServiceSelectedInConfig,
  isCloudConnected,
  migrateLegacyRuntimeConfig,
  isElizaSettingsDebugEnabled,
  settingsDebugCloudSummary,
  sanitizeSpeechText,
  getRuntimeRouteHostContext,
  registerAppRoutePluginLoader,
  resolveApiSecurityConfig,
  resolveDesktopApiPort,
  Service,
  IMediaGenerationService,
  AgentRuntime,
  DefaultMessageService,
  Semaphore,
  BM25,
};
