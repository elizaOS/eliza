/**
 * @elizaos/core Cloudflare Workers compatibility shim.
 *
 * The real package performs forbidden top-level I/O on Workers. Agent runtime
 * code runs on the Node sidecar (`services/agent-server`). This module keeps
 * Worker bundles resolvable, while runtime-only helpers throw if an accidental
 * Worker-side path reaches them.
 */

// The stub may bundle real core source ONLY when the module is pure — zero
// imports (or type-only), zero top-level I/O, zero node built-ins. Reusing
// the real module beats a drift-prone copy for anything security-relevant
// (SSRF blocklists, log redaction). Anything heavier gets a Worker-safe
// stand-in below instead.
import {
  isBlockedHostname,
  isPrivateIpAddress,
  type LookupFn,
  type PinnedHostname,
  type PinnedLookup,
  resolvePinnedHostname,
  resolvePinnedHostnameWithPolicy,
  SsrfBlockedError,
  type SsrfPolicy,
} from "../../../../core/src/network/ssrf";

// `globalThis` Symbol.for account-selection bridges (pure). app-core service
// modules bundled into the Worker call the setters at module scope.
export {
  ANTHROPIC_ACCOUNT_POOL_BRIDGE_SYMBOL,
  CODING_AGENT_SELECTOR_BRIDGE_SYMBOL,
  getAnthropicAccountPoolBridge,
  getCodingAgentSelectorBridge,
  setAnthropicAccountPoolBridge,
  setCodingAgentSelectorBridge,
} from "../../../../core/src/account-pool-bridge";
// Subscription-auth provider registry (pure Map). packages/auth registers and
// reads providers through @elizaos/core; every bundled import resolves to this
// stub, so re-exporting the real module keeps one shared registry instance.
export {
  getSubscriptionAuthProvider,
  hasSubscriptionAuthProvider,
  listSubscriptionAuthProviders,
  registerSubscriptionAuthProvider,
  resetSubscriptionAuthProviders,
} from "../../../../core/src/features/subscription-auth/registry.ts";

// Log-redaction helpers used by cloud-shared's logger. These MUST stay the
// real implementations — a pass-through here would leak API keys/tokens into
// Worker logs. Pure string/regex logic, safe to bundle.
export {
  isSensitiveKeyName,
  redactLogArgs,
} from "../../../../core/src/security/redact";
export type { SsrfPolicy };
export { SsrfBlockedError };

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
 * Worker-safe stand-in for `runWithTrajectoryPurpose`. In core this tags the
 * active trajectory context with a pipeline purpose before running `fn`; the
 * trajectory context manager lives on the agent sidecar and no trajectory is
 * ever recorded in the Worker bundle, so just run the function. (Pulled into
 * the bundle transitively via `@elizaos/shared` email-classification — not
 * invoked on a Worker route. Deleting this export breaks the Worker build:
 * #11845/#11875.)
 */
export function runWithTrajectoryPurpose<T>(
  _purpose: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return fn();
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

// ---------------------------------------------------------------------------
// SSRF-guarded fetch — Worker port of core `network/fetch-guard.ts`. Pulled
// into the bundle via plugin-elizacloud's transcription model (audioUrl
// fetches are attachment fetches and MUST stay SSRF-guarded). Mirrors core's
// edge branch exactly: workerd has no `node:dns`, so core itself documents
// this same no-pin literal-host mode for Workers (see EDGE-SSRF in core).
// The ONLY delta from core is dropping the Node-autoloaded pinned transport
// (`node-pinned-fetch`), which cannot run on workerd; callers may still
// inject `lookupFn` + `pinnedFetchImpl`, and a lookupFn WITHOUT a pinned
// transport fails CLOSED, same as core. Do not weaken these checks.
// ---------------------------------------------------------------------------

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PinnedLookupFetchParams = {
  url: URL;
  init: RequestInit;
  lookup: PinnedLookup;
  addresses: string[];
};

export type PinnedLookupFetchLike = (
  params: PinnedLookupFetchParams,
) => Promise<Response>;

export type GuardedFetchOptions = {
  url: string;
  fetchImpl?: FetchLike;
  pinnedFetchImpl?: PinnedLookupFetchLike;
  init?: RequestInit;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  policy?: SsrfPolicy;
  lookupFn?: LookupFn;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

const DEFAULT_MAX_REDIRECTS = 3;

// Credential-bearing headers that must never follow a redirect to a different
// origin (this guard follows redirects manually with `redirect: "manual"`, so
// it must reproduce the stripping standard fetch does).
const CROSS_ORIGIN_STRIPPED_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
] as const;

// Entity/body headers dropped when a redirect rewrites the request to a
// bodyless GET (301/302 POST, any 303), per the WHATWG redirect rules.
const REDIRECT_BODY_STRIPPED_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
] as const;

function stripCredentialHeaders(
  headers: HeadersInit | undefined,
): HeadersInit | undefined {
  if (!headers) {
    return headers;
  }
  const cleaned = new Headers(headers);
  for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) {
    cleaned.delete(name);
  }
  return cleaned;
}

function stripBodyHeaders(
  headers: HeadersInit | undefined,
): HeadersInit | undefined {
  if (!headers) {
    return headers;
  }
  const cleaned = new Headers(headers);
  for (const name of REDIRECT_BODY_STRIPPED_HEADERS) {
    cleaned.delete(name);
  }
  return cleaned;
}

function shouldRewriteToGet(status: number, method: string): boolean {
  const upper = method.toUpperCase();
  if ((status === 301 || status === 302) && upper === "POST") {
    return true;
  }
  if (status === 303 && upper !== "GET" && upper !== "HEAD") {
    return true;
  }
  return false;
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function buildAbortSignal(params: {
  timeoutMs?: number;
  signal?: AbortSignal;
}): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }

  if (!timeoutMs) {
    return { signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

/**
 * Fetch with SSRF protection — Worker-safe mirror of core's
 * `fetchWithSsrfGuard` contract:
 *
 * - Validates URL protocol (http/https only) on EVERY hop
 * - Blocks literal private/loopback/link-local IPs and internal hostnames via
 *   the real core validators (honoring `policy.allowPrivateNetwork` /
 *   `policy.allowedHostnames`)
 * - With an injected `lookupFn` + `pinnedFetchImpl`: resolves and pins DNS to
 *   also defend against rebinding; a `lookupFn` without a pinned transport
 *   throws (fail closed) — never downgrades to unpinned fetch
 * - Follows redirects manually, re-validating every hop, rewriting to a
 *   bodyless GET where the WHATWG rules require it, and stripping credential
 *   headers on cross-origin hops
 * - Supports timeout and abort signals
 */
export async function fetchWithSsrfGuard(
  params: GuardedFetchOptions,
): Promise<GuardedFetchResult> {
  const fetcher: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }
  const lookupFn = params.lookupFn;
  const pinnedFetchImpl = params.pinnedFetchImpl;

  // Same fail-closed footgun guard as core (#11147): a lookupFn computes a DNS
  // pin, but without a pinnedFetchImpl to connect to that pinned IP the pin
  // would be silently discarded, re-opening the rebinding race.
  if (lookupFn && !pinnedFetchImpl) {
    throw new Error(
      "SSRF guard: a DNS lookupFn was provided without a pinnedFetchImpl. " +
        "Refusing to fall back to the unpinned fetcher — the computed DNS pin " +
        "would be discarded, re-introducing a DNS-rebinding race. Provide a " +
        "pinnedFetchImpl alongside the lookupFn.",
    );
  }

  const maxRedirects =
    typeof params.maxRedirects === "number" &&
    Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : DEFAULT_MAX_REDIRECTS;

  const { signal, cleanup } = buildAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  let released = false;
  const release = async () => {
    if (released) {
      return;
    }
    released = true;
    cleanup();
  };

  const visited = new Set<string>();
  let currentUrl = params.url;
  let redirectCount = 0;
  let hopHeaders = params.init?.headers;
  let hopMethod = params.init?.method;
  let hopBodyDropped = false;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    try {
      let pinned: PinnedHostname | undefined;
      if (lookupFn) {
        const usePolicy = Boolean(
          params.policy?.allowPrivateNetwork ||
            params.policy?.allowedHostnames?.length,
        );
        pinned = usePolicy
          ? await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
              lookupFn,
              policy: params.policy,
            })
          : await resolvePinnedHostname(parsedUrl.hostname, lookupFn);
      } else {
        // EDGE-SSRF (matches core): no `node:dns` on workerd, so no socket
        // pinning — block literal internal targets on every hop; the residual
        // rebinding exposure is closed operationally by Cloudflare egress
        // policy (see core network/fetch-guard.ts EDGE-SSRF note).
        const allowPrivate = Boolean(params.policy?.allowPrivateNetwork);
        const host = parsedUrl.hostname.trim().toLowerCase().replace(/\.$/, "");
        const allowed = new Set(
          (params.policy?.allowedHostnames ?? []).map((value) =>
            value.trim().toLowerCase().replace(/\.$/, ""),
          ),
        );
        if (!allowPrivate && !allowed.has(host)) {
          if (isBlockedHostname(parsedUrl.hostname)) {
            await release();
            throw new SsrfBlockedError(
              `Blocked hostname: ${parsedUrl.hostname}`,
            );
          }
          if (isPrivateIpAddress(parsedUrl.hostname)) {
            await release();
            throw new SsrfBlockedError("Blocked: private/internal IP address");
          }
        }
      }

      const init: RequestInit = {
        ...(params.init ? { ...params.init } : {}),
        ...(hopHeaders ? { headers: hopHeaders } : {}),
        ...(hopMethod !== undefined ? { method: hopMethod } : {}),
        ...(hopBodyDropped ? { body: undefined } : {}),
        redirect: "manual",
        ...(signal ? { signal } : {}),
      };

      const response =
        pinned && pinnedFetchImpl
          ? await pinnedFetchImpl({
              url: parsedUrl,
              init,
              lookup: pinned.lookup,
              addresses: pinned.addresses,
            })
          : await fetcher(parsedUrl.toString(), init);

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          await release();
          throw new Error(
            `Redirect missing location header (${response.status})`,
          );
        }
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          await release();
          throw new Error(`Too many redirects (limit: ${maxRedirects})`);
        }
        const nextParsedUrl = new URL(location, parsedUrl);
        const nextUrl = nextParsedUrl.toString();
        if (visited.has(nextUrl)) {
          await release();
          throw new Error("Redirect loop detected");
        }
        visited.add(nextUrl);
        if (shouldRewriteToGet(response.status, hopMethod ?? "GET")) {
          hopMethod = "GET";
          hopBodyDropped = true;
          hopHeaders = stripBodyHeaders(hopHeaders);
        }
        if (parsedUrl.origin !== nextParsedUrl.origin) {
          hopHeaders = stripCredentialHeaders(hopHeaders);
        }
        void response.body?.cancel();
        currentUrl = nextUrl;
        continue;
      }

      return {
        response,
        finalUrl: currentUrl,
        release,
      };
    } catch (err) {
      await release();
      throw err;
    }
  }
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

const registeredConnectorAliases = new Map<string, Set<string>>();

export function registerConnectorSourceAliases(
  canonical: string,
  aliases: readonly string[],
): void {
  const key = canonical.trim().toLowerCase();
  if (!key) return;
  const existing = registeredConnectorAliases.get(key) ?? new Set<string>();
  for (const alias of aliases) {
    const normalized = alias.trim().toLowerCase();
    if (normalized) existing.add(normalized);
  }
  registeredConnectorAliases.set(key, existing);
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
  for (const [canonical, aliases] of registeredConnectorAliases) {
    if (aliases.has(trimmed)) return canonical;
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
      ...(registeredConnectorAliases.get(canonical) ?? []),
    ]),
  );
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

// Mirrors core's `cloud-auth-service.ts` (`ServiceType.CLOUD_AUTH`). Pulled in
// via plugin-elizacloud's cloud-auth service, which the Worker bundle reaches
// transitively — the service itself runs on the agent sidecar.
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
