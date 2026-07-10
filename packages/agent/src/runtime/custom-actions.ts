/**
 * Custom Actions runtime loader.
 *
 * Converts `CustomActionDef[]` from config into elizaOS `Action[]` objects
 * so the agent can use them in conversations.
 *
 * @module runtime/custom-actions
 */

import { lookup as dnsLookup } from "node:dns/promises";
import {
  type RequestOptions as HttpRequestOptions,
  type IncomingMessage,
  request as requestHttp,
} from "node:http";
import { request as requestHttps } from "node:https";
import net from "node:net";
import {
  type Action,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
} from "@elizaos/core";
import { resolveApiToken, resolveServerOnlyPort } from "@elizaos/shared";
import { hasSelectedContextOrSignalSync } from "../actions/context-signal.ts";
import { loadElizaConfig } from "../config/config.ts";
import type {
  CustomActionDef,
  CustomActionHandler,
} from "../config/types.eliza.ts";
import {
  isBlockedPrivateOrLinkLocalIp,
  normalizeHostLike,
} from "../security/network-policy.ts";

/** Cached runtime reference for hot-registration of new actions. */
let _runtime: IAgentRuntime | null = null;

/**
 * Store the runtime reference so we can hot-register actions later.
 * Called once from plugin.init().
 */
export function setCustomActionsRuntime(runtime: IAgentRuntime): void {
  _runtime = runtime;
}

/**
 * Hot-register a CustomActionDef into the running agent.
 * Returns the elizaOS Action that was registered, or null if no runtime.
 */
export function registerCustomActionLive(def: CustomActionDef): Action | null {
  if (!_runtime) return null;
  const action = defToAction(def);
  _runtime.registerAction(action);
  return action;
}

/** Valid handler types that we actually support. */
const VALID_HANDLER_TYPES = new Set(["http", "shell", "code"]);

type VmRunner = {
  runInNewContext: (
    code: string,
    contextObject: Record<string, unknown>,
    options?: { filename?: string; timeout?: number },
  ) => unknown;
};

let vmRunner: VmRunner | null = null;

const CUSTOM_ACTION_FETCH_TIMEOUT_MS = 15_000;
const CUSTOM_ACTION_SHELL_TIMEOUT_MS = 30_000;
const CUSTOM_ACTION_CONTEXTS = [
  "general",
  "automation",
  "connectors",
  "agent_internal",
] as const;

type FetchInput = Parameters<typeof fetch>[0];
type FetchBody = RequestInit["body"];

export class CustomActionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomActionTimeoutError";
  }
}

type ResolvedUrlTarget = {
  parsed: URL;
  hostname: string;
  pinnedAddress: string;
};

type PinnedFetchInput = {
  url: URL;
  init: RequestInit;
  target: ResolvedUrlTarget;
  timeoutMs: number;
};

type PinnedFetchImpl = (input: PinnedFetchInput) => Promise<Response>;
type DnsLookupRecord = { address?: unknown } | string;
type DnsLookupAllFn = (
  hostname: string,
  options: { all: true },
) => Promise<DnsLookupRecord[] | DnsLookupRecord>;

let dnsLookupImpl: DnsLookupAllFn = dnsLookup as DnsLookupAllFn;

function getApiPort(): string {
  return String(resolveServerOnlyPort(process.env));
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeoutMessage = `Terminal request timed out after ${timeoutMs}ms`;

  return await new Promise<Response>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      controller.abort();
      if (settled) return;
      settled = true;
      reject(new CustomActionTimeoutError(timeoutMessage));
    }, timeoutMs);

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    };

    fetch(input, {
      ...init,
      signal: controller.signal,
    }).then(
      (response) => settle(() => resolve(response)),
      (error) => {
        if (controller.signal.aborted) {
          settle(() => reject(new CustomActionTimeoutError(timeoutMessage)));
          return;
        }
        settle(() => reject(error));
      },
    );
  });
}

function resolveFetchInputUrl(input: FetchInput | URL): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

async function safeCodeFetch(
  input: FetchInput | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = resolveFetchInputUrl(input);
  if (!url) {
    throw new Error(
      "Blocked: cannot make requests to internal network addresses",
    );
  }

  const safety = await resolveUrlSafety(url);
  if (safety.blocked) {
    throw new Error(
      "Blocked: cannot make requests to internal network addresses",
    );
  }

  const requestInit = await buildPinnedFetchInit(input, init);
  const response = safety.target
    ? await fetchWithPinnedTarget(
        safety.target,
        requestInit,
        CUSTOM_ACTION_FETCH_TIMEOUT_MS,
      )
    : await fetch(input, requestInit);
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      "Blocked: redirects are not allowed for code custom actions",
    );
  }

  return response;
}

async function runCodeHandler(
  code: string,
  params: Record<string, string>,
): Promise<unknown> {
  if (typeof process === "undefined" || !process.versions.node) {
    throw new Error("Code actions are only supported in Node runtimes.");
  }

  if (!vmRunner) {
    vmRunner = (await import("node:vm")) as VmRunner;
  }

  const script = `(async () => { ${code} })();`;
  const context: Record<string, unknown> = Object.create(null);
  context.params = Object.freeze({ ...params });

  const wrapperScript = `(function(hostFetch) {
    return function fetch(input, init) { return hostFetch(input, init); };
  })`;
  const wrapFetch = vmRunner.runInNewContext(
    wrapperScript,
    Object.create(null),
    {
      filename: "eliza-fetch-wrapper",
      timeout: 1_000,
    },
  ) as (fn: typeof safeCodeFetch) => typeof safeCodeFetch;
  context.fetch = wrapFetch(safeCodeFetch);

  return vmRunner.runInNewContext(`"use strict"; ${script}`, context, {
    filename: "eliza-custom-action",
    timeout: 30_000,
  });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isBlockedIp(ip: string): boolean {
  return isBlockedPrivateOrLinkLocalIp(ip);
}

function normalizeDnsAddress(record: unknown): string | null {
  const raw =
    typeof record === "string"
      ? record
      : record && typeof record === "object"
        ? (record as { address?: unknown }).address
        : undefined;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRequestHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

async function toRequestBodyBuffer(
  body: FetchBody | null | undefined,
): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("Unsupported request body type for custom action fetch");
}

function incomingMessageBody(
  response: IncomingMessage,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on("data", (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === "string"
            ? Buffer.from(chunk)
            : new Uint8Array(chunk),
        );
      });
      response.on("end", () => controller.close());
      response.on("error", (error) => controller.error(error));
    },
    cancel() {
      response.destroy();
    },
  });
}

function responseFromIncomingMessage(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }

  const status = response.statusCode ?? 500;
  const body =
    status === 204 || status === 205 || status === 304
      ? null
      : incomingMessageBody(response);

  return new Response(body, {
    status,
    statusText: response.statusMessage,
    headers,
  });
}

async function requestWithPinnedAddress(
  input: PinnedFetchInput,
): Promise<Response> {
  const { url, init, target, timeoutMs } = input;
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const bodyBuffer = await toRequestBodyBuffer(init.body);
  if (bodyBuffer && !headers.has("content-length")) {
    headers.set("content-length", String(bodyBuffer.byteLength));
  }

  const requestFn = url.protocol === "https:" ? requestHttps : requestHttp;
  const family = net.isIP(target.pinnedAddress) === 6 ? 6 : 4;

  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    const signal = init.signal;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => {
      request.destroy(new DOMException("Aborted", "AbortError"));
    };

    const requestOptions: HttpRequestOptions = {
      protocol: url.protocol,
      hostname: target.hostname,
      port: url.port ? Number(url.port) : undefined,
      method,
      path: `${url.pathname}${url.search}`,
      headers: toRequestHeaders(headers),
      // Honor the `all` option: Node 20+ defaults autoSelectFamily=true and, for
      // dual-stack hosts, calls lookup with `{ all: true }` expecting an ARRAY
      // of `{ address, family }`. Returning the single-arg form there makes Node
      // read the address string as an array (`addr[0].address` -> undefined) and
      // throw "Invalid IP address: undefined", failing every pinned fetch to a
      // dual-stack host (e.g. coingecko). Branch on the option to satisfy both.
      lookup: (_hostname, options, callback) => {
        const wantsAll =
          typeof options === "object" &&
          options !== null &&
          options.all === true;
        if (wantsAll) {
          callback(null, [{ address: target.pinnedAddress, family }]);
          return;
        }
        callback(null, target.pinnedAddress, family);
      },
      ...(url.protocol === "https:"
        ? { servername: target.hostname }
        : undefined),
    };

    const request = requestFn(requestOptions, (response) => {
      settle(() => resolve(responseFromIncomingMessage(response)));
    });

    request.on("error", (error) => {
      settle(() => reject(error));
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    timeoutHandle = setTimeout(() => {
      request.destroy(
        new Error(`Custom action request timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    if (bodyBuffer) {
      request.write(bodyBuffer);
    }
    request.end();
  });
}

let pinnedFetchImpl: PinnedFetchImpl = requestWithPinnedAddress;

export function __setPinnedFetchImplForTests(
  impl: PinnedFetchImpl | null,
): void {
  pinnedFetchImpl = impl ?? requestWithPinnedAddress;
}

export function __setDnsLookupImplForTests(impl: DnsLookupAllFn | null): void {
  dnsLookupImpl = impl ?? (dnsLookup as DnsLookupAllFn);
}

async function resolveUrlSafety(url: string): Promise<{
  blocked: boolean;
  target: ResolvedUrlTarget | null;
}> {
  try {
    const parsed = new URL(url);
    const hostname = normalizeHostLike(parsed.hostname);
    if (!hostname) return { blocked: true, target: null };

    if (
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1") &&
      parsed.port === getApiPort()
    ) {
      return { blocked: false, target: null };
    }

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname === "[::1]" ||
      hostname === "metadata.google.internal" ||
      hostname === "169.254.169.254"
    ) {
      return { blocked: true, target: null };
    }

    if (net.isIP(hostname)) {
      if (isBlockedIp(hostname)) return { blocked: true, target: null };
      return {
        blocked: false,
        target: {
          parsed,
          hostname,
          pinnedAddress: hostname,
        },
      };
    }

    const records = await dnsLookupImpl(hostname, { all: true });
    const addresses = (Array.isArray(records) ? records : [records])
      .map(normalizeDnsAddress)
      .filter((address): address is string => Boolean(address));
    if (addresses.length === 0) {
      return { blocked: true, target: null };
    }
    for (const address of addresses) {
      if (isBlockedIp(address)) {
        return { blocked: true, target: null };
      }
    }

    return {
      blocked: false,
      target: {
        parsed,
        hostname,
        pinnedAddress: addresses[0] ?? "",
      },
    };
  } catch {
    return { blocked: true, target: null };
  }
}

async function buildPinnedFetchInit(
  input: FetchInput | URL,
  init?: RequestInit,
): Promise<RequestInit> {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const headers = new Headers(input.headers);
    if (init?.headers) {
      const overrideHeaders = new Headers(init.headers);
      overrideHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }

    const method = init?.method ?? input.method;
    const bodyFromInit = init?.body;
    const bodyFromRequest =
      bodyFromInit !== undefined
        ? undefined
        : method === "GET" || method === "HEAD"
          ? undefined
          : await input.clone().arrayBuffer();

    return {
      ...init,
      method,
      headers,
      body: bodyFromInit ?? bodyFromRequest,
      signal: init?.signal ?? input.signal,
      redirect: "manual",
    };
  }

  return {
    ...init,
    redirect: "manual",
  };
}

async function fetchWithPinnedTarget(
  target: ResolvedUrlTarget,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (!target.pinnedAddress || net.isIP(target.pinnedAddress) === 0) {
    throw new Error(
      "Blocked: cannot make requests to internal network addresses",
    );
  }
  return pinnedFetchImpl({
    url: target.parsed,
    init,
    target,
    timeoutMs,
  });
}

/** Hard cap on the response body we read from a guarded GET. */
const GUARDED_GET_MAX_BYTES = 256 * 1024;
// Redirect-hop cap for the guarded fetch: enough for a rename 301 plus a
// canonicalization hop, small enough that a redirect loop dies fast.
const GUARDED_GET_MAX_REDIRECTS = 3;

/** Hard cap on the response body we read from a legacy `http` custom action. */
const CUSTOM_ACTION_HTTP_MAX_CHARS = 4_000;

/**
 * Read a fetch response body as text, streaming and stopping once `maxChars`
 * characters have been collected. Avoids buffering an unbounded (or hostile)
 * response into memory the way `response.text()` would before any slice.
 */
async function readBodyTextCapped(
  response: Response,
  maxChars: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= maxChars) {
        text = text.slice(0, maxChars);
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

export interface GuardedHttpGetOptions {
  /** Request timeout in milliseconds. Defaults to the custom-action cap. */
  timeoutMs?: number;
  /** Maximum number of body characters to read. Defaults to {@link GUARDED_GET_MAX_BYTES}. */
  maxChars?: number;
  /** Optional extra request headers (e.g. Accept). */
  headers?: Record<string, string>;
}

export interface GuardedHttpGetResult {
  /** True when the host passed the SSRF guard and the request completed. */
  ok: boolean;
  /** HTTP status code, or 0 when the request was blocked before sending. */
  status: number;
  /** Truncated response body text (empty when blocked). */
  text: string;
  /** True when the URL was rejected by the SSRF / scheme guard. */
  blocked: boolean;
}

// Default User-Agent for guarded GETs. Many public REST/JSON APIs (crypto
// price, weather, news endpoints) reject undici's default `node` User-Agent - or
// a missing one - with HTTP 403, which silently broke every WEB_FETCH live-info
// lookup. A browser-like string is what these WAF-fronted endpoints accept; it
// is overridable via ELIZA_WEB_FETCH_USER_AGENT so operators can refresh it
// without a code change, and any caller-supplied User-Agent header still wins.
const GUARDED_GET_OPERATOR_USER_AGENT =
  process.env.ELIZA_WEB_FETCH_USER_AGENT?.trim() || undefined;
const GUARDED_GET_DEFAULT_USER_AGENT =
  GUARDED_GET_OPERATOR_USER_AGENT ||
  [
    "Mozilla/5.0 (X11; Linux x86_64)",
    "AppleWebKit/537.36 (KHTML, like Gecko)",
    "Chrome/124.0.0.0 Safari/537.36",
  ].join(" ");

export interface GuardedHttpPostOptions extends GuardedHttpGetOptions {
  /** Request body. Sent as `application/json` unless `Content-Type` is set. */
  body: string;
}

interface GuardedHttpRequestOptions extends GuardedHttpGetOptions {
  method: "GET" | "POST";
  /** Optional body (POST). Defaults Content-Type to `application/json`. */
  body?: string;
}

/**
 * Single SSRF-guarded, https-only HTTP request used by both the GET and POST
 * wrappers below — keeping the guard (DNS-pinned private/link-local blocking via
 * {@link resolveUrlSafety} + {@link fetchWithPinnedTarget}, https-only scheme,
 * redirect rejection, timeout + body cap) in ONE place so a future safety fix
 * never has to be made twice. Public callers use {@link performGuardedHttpGet} /
 * {@link performGuardedHttpPost}.
 */
async function performGuardedHttpRequest(
  url: string,
  opts: GuardedHttpRequestOptions,
): Promise<GuardedHttpGetResult> {
  const timeoutMs = opts.timeoutMs ?? CUSTOM_ACTION_FETCH_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? GUARDED_GET_MAX_BYTES;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 0, text: "", blocked: true };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, status: 0, text: "", blocked: true };
  }

  const safety = await resolveUrlSafety(url);
  if (safety.blocked) {
    return { ok: false, status: 0, text: "", blocked: true };
  }

  // wttr.in content-negotiates on User-Agent: any "Mozilla" UA gets the
  // interactive HTML page (and the ?format= param is ignored), while the compact
  // plain-text weather line the live-info WEB_FETCH actually wants is served only
  // to a non-browser UA (it is built for `curl wttr.in`). The browser-like
  // default above exists to satisfy WAF-fronted JSON APIs (coingecko etc.), so
  // scope the CLI UA to wttr.in rather than changing the global default.
  // Precedence: caller-supplied header (set below) > operator env override
  // (ELIZA_WEB_FETCH_USER_AGENT applies to EVERY host — an egress proxy that
  // allowlists a specific UA must not be bypassed for wttr.in) > per-host CLI
  // UA > browser default. Trailing-dot FQDNs ("wttr.in.") normalize to the
  // same host.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const isPlainTextCliHost = host === "wttr.in" || host.endsWith(".wttr.in");
  const defaultUserAgent =
    GUARDED_GET_OPERATOR_USER_AGENT ??
    (isPlainTextCliHost
      ? "Eliza/1.0 (+https://elizaos.ai)"
      : GUARDED_GET_DEFAULT_USER_AGENT);
  // Build headers via the Headers API so a caller-supplied header (in any
  // casing) cleanly overrides the default rather than being comma-joined onto it.
  const headers = new Headers({ "User-Agent": defaultUserAgent });
  if (opts.body !== undefined) headers.set("Content-Type", "application/json");
  if (opts.headers) {
    for (const [key, value] of Object.entries(opts.headers)) {
      headers.set(key, value);
    }
  }

  const fetchOpts: RequestInit = {
    method: opts.method,
    headers,
    redirect: "manual",
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  };

  // Follow a bounded redirect chain, re-running the FULL safety check on every
  // hop. Public APIs legitimately 3xx (a renamed GitHub repo 301s to its new
  // slug; hard-blocking every 3xx turned those into "blocked host" failures).
  // The SSRF risk in following redirects is a hop that lands on an internal
  // host — mitigated by treating each Location as a brand-new URL: https-only
  // and `resolveUrlSafety` per hop, with the redirect count capped.
  let currentUrl = url;
  let currentSafety = safety;
  for (let hop = 0; hop <= GUARDED_GET_MAX_REDIRECTS; hop++) {
    const response = currentSafety.target
      ? await fetchWithPinnedTarget(currentSafety.target, fetchOpts, timeoutMs)
      : await fetch(currentUrl, fetchOpts);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop === GUARDED_GET_MAX_REDIRECTS) {
        return { ok: false, status: response.status, text: "", blocked: true };
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        // error-policy:J3 malformed Location from an untrusted server → block
        return { ok: false, status: response.status, text: "", blocked: true };
      }
      if (nextUrl.protocol !== "https:") {
        return { ok: false, status: response.status, text: "", blocked: true };
      }
      const nextSafety = await resolveUrlSafety(nextUrl.toString());
      // A null target is resolveUrlSafety's self-API loopback exemption. Fine
      // for a caller-typed URL; NOT fine as a redirect destination — an
      // external host must not be able to 3xx the agent into its own API.
      if (nextSafety.blocked || !nextSafety.target) {
        return { ok: false, status: response.status, text: "", blocked: true };
      }
      // HTTP redirect semantics + cross-origin hygiene: 303 (and the
      // conventional 301/302-with-body demotion) becomes a bodyless GET, and
      // credential-bearing headers never follow a hop to a different origin.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          fetchOpts.body !== undefined)
      ) {
        fetchOpts.method = "GET";
        fetchOpts.body = undefined;
        (fetchOpts.headers as Headers).delete("Content-Type");
      }
      if (nextUrl.origin !== new URL(currentUrl).origin) {
        for (const h of ["authorization", "cookie", "proxy-authorization"]) {
          (fetchOpts.headers as Headers).delete(h);
        }
      }
      currentUrl = nextUrl.toString();
      currentSafety = nextSafety;
      continue;
    }

    const text = await readBodyTextCapped(response, maxChars);
    return { ok: response.ok, status: response.status, text, blocked: false };
  }
  // Unreachable: every iteration inside the cap returns or continues.
  return { ok: false, status: 0, text: "", blocked: true };
}

/** SSRF-guarded https-only GET (custom actions + the built-in WEB_FETCH action). */
export async function performGuardedHttpGet(
  url: string,
  opts: GuardedHttpGetOptions = {},
): Promise<GuardedHttpGetResult> {
  return performGuardedHttpRequest(url, { ...opts, method: "GET" });
}

/**
 * SSRF-guarded HTTPS POST with a body (default `application/json`) — used by
 * inline actions that call a public JSON/MCP endpoint (e.g. the keyless
 * web-search MCP). Same guard as {@link performGuardedHttpGet}.
 */
export async function performGuardedHttpPost(
  url: string,
  opts: GuardedHttpPostOptions,
): Promise<GuardedHttpGetResult> {
  return performGuardedHttpRequest(url, { ...opts, method: "POST" });
}

function buildHandler(
  handler: CustomActionHandler,
  paramDefs: CustomActionDef["parameters"],
): (
  params: Record<string, string>,
) => Promise<{ ok: boolean; output: string }> {
  if (!VALID_HANDLER_TYPES.has(handler.type)) {
    return async () => ({
      ok: false,
      output: `Unsupported handler type: ${handler.type}`,
    });
  }

  switch (handler.type) {
    case "http":
      return async (params) => {
        let url = handler.url;
        let body = handler.bodyTemplate ?? "";
        const headers: Record<string, string> = { ...handler.headers };

        for (const p of paramDefs) {
          const value = params[p.name] ?? "";
          url = url.replaceAll(`{{${p.name}}}`, encodeURIComponent(value));
          body = body.replaceAll(`{{${p.name}}}`, value);
        }

        const safety = await resolveUrlSafety(url);
        if (safety.blocked) {
          return {
            ok: false,
            output:
              "Blocked: cannot make requests to internal network addresses",
          };
        }

        if (!headers["Content-Type"] && body) {
          headers["Content-Type"] = "application/json";
        }

        const fetchOpts: RequestInit = {
          method: handler.method || "GET",
          headers,
          redirect: "manual",
        };
        if (body && handler.method !== "GET" && handler.method !== "HEAD") {
          fetchOpts.body = body;
        }

        const response = safety.target
          ? await fetchWithPinnedTarget(
              safety.target,
              fetchOpts,
              CUSTOM_ACTION_FETCH_TIMEOUT_MS,
            )
          : await fetch(url, fetchOpts);
        if (response.status >= 300 && response.status < 400) {
          return {
            ok: false,
            output:
              "Blocked: redirects are not allowed for HTTP custom actions",
          };
        }
        const text = await readBodyTextCapped(
          response,
          CUSTOM_ACTION_HTTP_MAX_CHARS,
        );
        return { ok: response.ok, output: text };
      };

    case "shell":
      return async (params) => {
        let command = handler.command;
        for (const p of paramDefs) {
          const value = params[p.name] ?? "";
          command = command.replaceAll(`{{${p.name}}}`, shellEscape(value));
        }

        const response = await fetchWithTimeout(
          `http://localhost:${getApiPort()}/api/terminal/run`,
          {
            method: "POST",
            headers: (() => {
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
              };
              const token = resolveApiToken(process.env);
              if (token) {
                headers.Authorization = /^Bearer\s+/i.test(token)
                  ? token
                  : `Bearer ${token}`;
              }
              return headers;
            })(),
            body: JSON.stringify({
              command,
              clientId: "runtime-shell-action",
            }),
          },
          CUSTOM_ACTION_SHELL_TIMEOUT_MS,
        );

        if (!response.ok) {
          return {
            ok: false,
            output: `Terminal request failed: HTTP ${response.status}`,
          };
        }

        return { ok: true, output: `Executed: ${command}` };
      };

    case "code":
      return async (params) => {
        const result = await runCodeHandler(handler.code, params);
        const output = result !== undefined ? String(result) : "Done";
        return { ok: true, output: output.slice(0, 4000) };
      };

    default:
      return async () => ({ ok: false, output: "Unknown handler type" });
  }
}

function defToAction(def: CustomActionDef): Action {
  const handler = buildHandler(def.handler, def.parameters);
  const validationTerms = [
    def.name,
    ...(def.similes ?? []),
    ...def.name.split(/[_\s-]+/),
    ...def.description.split(/[\s,.;:()[\]{}'"`/\\-]+/),
  ].filter((term) => term.trim().length > 2);

  return {
    name: def.name,
    contexts: [...CUSTOM_ACTION_CONTEXTS],
    roleGate:
      def.requiredRole && def.requiredRole !== "GUEST"
        ? { minRole: def.requiredRole }
        : { minRole: "USER" },
    similes: def.similes ?? [],
    description: def.description,
    validate: async (_runtime, message, state) => {
      return hasSelectedContextOrSignalSync(
        message,
        state,
        CUSTOM_ACTION_CONTEXTS,
        validationTerms,
      );
    },

    handler: async (_runtime, _message, _state, options) => {
      try {
        const opts = options as HandlerOptions | undefined;
        const params: Record<string, string> = {};

        for (const p of def.parameters) {
          const value = opts?.parameters?.[p.name];
          if (typeof value === "string") {
            params[p.name] = value;
          } else if (value !== undefined && value !== null) {
            params[p.name] = String(value);
          } else if (p.required) {
            return {
              text: `Missing required parameter: ${p.name}`,
              success: false,
            };
          }
        }

        const result = await handler(params);
        return {
          text: result.output,
          success: result.ok,
          data: { actionId: def.id, params },
        };
      } catch (err) {
        return {
          text: `Action failed: ${String(err)}`,
          success: false,
        };
      }
    },

    parameters: def.parameters.map((p) => ({
      name: p.name,
      description: p.description,
      required: p.required,
      schema: { type: "string" as const },
    })),
  };
}

export function loadCustomActions(): Action[] {
  try {
    const config = loadElizaConfig();
    const defs = config.customActions ?? [];
    return defs.filter((d) => d.enabled).map(defToAction);
  } catch (err) {
    logger.warn(
      `[custom-actions] Failed to load custom actions from config: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }
}

export function buildTestHandler(
  def: CustomActionDef,
): (
  params: Record<string, string>,
) => Promise<{ ok: boolean; output: string }> {
  return buildHandler(def.handler, def.parameters);
}
