/**
 * Guarded HTTP reader for coding-agent web tools. It delegates host validation,
 * DNS pinning, and redirect checks to the core SSRF guard, then enforces the
 * plugin's web-tool policy: HTTPS-only requests, bounded streamed reads, and
 * text-oriented content types.
 */
import {
  fetchWithSsrfGuard,
  type GuardedFetchOptions,
  type LookupFn,
  nodeLookupFn,
  nodePinnedFetch,
  type PinnedLookupFetchLike,
} from "@elizaos/core";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_USER_AGENT = "ElizaCodingTools/1.0 (+https://elizaos.ai)";

type FetchLike = NonNullable<GuardedFetchOptions["fetchImpl"]>;

let fetchImplOverride: FetchLike | undefined;
let lookupFnOverride: LookupFn | undefined;
let pinnedFetchImplOverride: PinnedLookupFetchLike | undefined;

export function __setWebHttpFetchImplForTests(
  impl: FetchLike | undefined,
): void {
  fetchImplOverride = impl;
}

export function __setWebHttpLookupFnForTests(impl: LookupFn | undefined): void {
  lookupFnOverride = impl;
}

export function __setWebHttpPinnedFetchImplForTests(
  impl: PinnedLookupFetchLike | undefined,
): void {
  pinnedFetchImplOverride = impl;
}

export function __resetWebHttpTestOverrides(): void {
  fetchImplOverride = undefined;
  lookupFnOverride = undefined;
  pinnedFetchImplOverride = undefined;
}

export interface GuardedTextHttpOptions {
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface GuardedTextHttpResult {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

function isTextualContentType(contentType: string): boolean {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!normalized) return true;
  if (normalized.startsWith("text/")) return true;
  if (normalized === "application/json") return true;
  if (normalized.endsWith("+json")) return true;
  if (normalized === "application/xml" || normalized.endsWith("+xml")) {
    return true;
  }
  if (
    normalized === "application/javascript" ||
    normalized === "application/x-javascript"
  ) {
    return true;
  }
  return false;
}

async function readTextCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        bytes += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
    if (bytes >= maxBytes) {
      const next = await reader.read();
      if (!next.done) {
        truncated = true;
        await reader.cancel();
      }
    }
  } finally {
    reader.releaseLock();
  }

  let text = "";
  for (const chunk of chunks) {
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated };
}

/**
 * Every hop (including redirect targets) must be HTTPS. The core guard allows
 * plain HTTP, so a 30x hop to `http://...` would otherwise be REQUESTED before
 * any post-hoc `finalUrl` check runs — leaking the request (and, on 307/308, a
 * POST body such as a WEB_SEARCH query) over plaintext. This preflight rejects
 * the plaintext hop before the transport ever connects.
 */
function rejectPlaintextHop(url: URL): void {
  if (url.protocol !== "https:") {
    throw new Error("Refusing HTTPS redirect downgrade to a non-HTTPS URL");
  }
}

type ResolvedTransport = {
  fetchImpl?: FetchLike;
  lookupFn?: LookupFn;
  pinnedFetchImpl?: PinnedLookupFetchLike;
};

/**
 * Wire the SSRF-guard transport so the HTTPS-only preflight wraps EVERY path
 * that can issue a request. In production the Node pinned transport is passed
 * explicitly (instead of relying on the guard's internal defaults) so the
 * wrapper cannot be bypassed; test overrides are wrapped the same way.
 */
function resolveHttpsOnlyTransport(): ResolvedTransport {
  if (fetchImplOverride && !pinnedFetchImplOverride) {
    // Plain-fetch test seam: literal-host checks only, every hop preflighted.
    const base = fetchImplOverride;
    return {
      fetchImpl: (input, init) => {
        rejectPlaintextHop(new URL(String(input)));
        return base(input, init);
      },
      ...(lookupFnOverride ? { lookupFn: lookupFnOverride } : {}),
    };
  }
  const basePinned = pinnedFetchImplOverride ?? nodePinnedFetch;
  const lookupFn = lookupFnOverride ?? nodeLookupFn;
  const pinned: PinnedLookupFetchLike = (params) => {
    rejectPlaintextHop(params.url);
    return basePinned(params);
  };
  return { lookupFn, pinnedFetchImpl: pinned };
}

export async function guardedTextHttpRequest(
  url: string,
  options: GuardedTextHttpOptions = {},
): Promise<GuardedTextHttpResult> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Only https URLs are allowed");
  }

  const headers = new Headers({
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "text/html,application/json,text/plain,*/*;q=0.1",
  });
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers.set(key, value);
  }

  const transport = resolveHttpsOnlyTransport();
  const guarded = await fetchWithSsrfGuard({
    url,
    ...transport,
    maxRedirects: DEFAULT_MAX_REDIRECTS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    init: {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
    },
  });

  try {
    if (new URL(guarded.finalUrl).protocol !== "https:") {
      void guarded.response.body?.cancel();
      throw new Error("Refusing HTTPS redirect downgrade to a non-HTTPS URL");
    }
    const contentType = guarded.response.headers.get("content-type") ?? "";
    if (!isTextualContentType(contentType)) {
      // Close the rejected body — an unconsumed large/streaming binary body
      // would otherwise hold the socket open until the remote closes it.
      void guarded.response.body?.cancel().catch(() => {});
      throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    }
    const { text, truncated } = await readTextCapped(
      guarded.response,
      options.maxBytes ?? DEFAULT_MAX_BYTES,
    );
    return {
      ok: guarded.response.ok,
      status: guarded.response.status,
      url: guarded.finalUrl,
      contentType,
      text,
      truncated,
    };
  } finally {
    await guarded.release();
  }
}
