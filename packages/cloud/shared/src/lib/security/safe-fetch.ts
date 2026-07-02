import type { LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";

import { isForbiddenIpAddress, normalizeHostname, resolveSafeOutboundTarget } from "./outbound-url";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Build a `node:net` lookup hook that always resolves to a single
 * pre-validated address instead of consulting DNS. This is what pins an
 * outbound socket: even though the request still carries the original hostname
 * (so TLS SNI, certificate validation, and the Host header stay correct), the
 * TCP connection can only ever reach `address`. The forbidden-range check is
 * re-run inside the hook as defence-in-depth so a bug upstream cannot smuggle a
 * private address past the pin.
 */
export function createPinnedLookup(address: string, family: number) {
  return (_hostname: string, options: unknown, callback: LookupCallback): void => {
    if (isForbiddenIpAddress(address)) {
      callback(new Error("Pinned address resolved to a private or reserved IP"));
      return;
    }

    if (options && typeof options === "object" && (options as { all?: boolean }).all) {
      callback(null, [{ address, family }]);
      return;
    }

    callback(null, address, family);
  };
}

/**
 * Cloudflare Workers (`workerd`) cannot pin `fetch()` to an arbitrary IP, so on
 * that runtime safeFetch falls back to validate-immediately-before-fetch plus
 * per-hop redirect re-validation. A residual rebinding window remains there
 * (DNS can change between our validation and the platform's connect); the
 * daemon/Node sinks — where the SSRF-sensitive provisioning webhooks run — get
 * true IP pinning below.
 */
function canPinSockets(): boolean {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : undefined;
  if (userAgent === "Cloudflare-Workers") {
    return false;
  }
  return typeof process !== "undefined" && !!process.versions?.node;
}

function toOutgoingHeaders(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers ?? undefined);
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    // Let Node derive Host from the connection target (the original hostname).
    if (key.toLowerCase() === "host") return;
    out[key] = value;
  });
  return out;
}

async function nodePinnedFetch(
  url: URL,
  address: string,
  family: number,
  init: RequestInit,
): Promise<Response> {
  const isHttps = url.protocol === "https:";
  const httpModule = isHttps ? await import("node:https") : await import("node:http");
  const request = httpModule.request as typeof import("node:https").request;

  const method = (init.method ?? "GET").toUpperCase();
  const hostname = normalizeHostname(url.hostname);

  const options: RequestOptions = {
    protocol: url.protocol,
    hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method,
    headers: toOutgoingHeaders(init),
    lookup: createPinnedLookup(address, family) as RequestOptions["lookup"],
    // Keep TLS SNI + certificate validation bound to the real hostname even
    // though the socket connects to the pinned IP.
    servername: isHttps ? hostname : undefined,
    signal: init.signal ?? undefined,
  };

  return await new Promise<Response>((resolve, reject) => {
    const req = request(options, (res) => {
      const status = res.statusCode ?? 0;
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) headers.append(key, entry);
        } else if (value != null) {
          headers.set(key, String(value));
        }
      }

      const bodyless = method === "HEAD" || status === 204 || status === 205 || status === 304;
      const body = bodyless ? null : nodeResponseBodyStream(res);
      resolve(new Response(body, { status, statusText: res.statusMessage, headers }));
    });

    req.on("error", reject);
    writeRequestBody(req, method, init.body);
  });
}

function toUint8ArrayChunk(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return new TextEncoder().encode(chunk);
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return new TextEncoder().encode(String(chunk));
}

function nodeResponseBodyStream(res: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        res.off("data", onData);
        res.off("end", onEnd);
        res.off("error", onError);
      };
      const onData = (chunk: unknown) => controller.enqueue(toUint8ArrayChunk(chunk));
      const onEnd = () => {
        cleanup();
        controller.close();
      };
      const onError = (error: Error) => {
        cleanup();
        controller.error(error);
      };
      res.on("data", onData);
      res.on("end", onEnd);
      res.on("error", onError);
    },
    cancel() {
      res.destroy();
    },
  });
}

function writeRequestBody(req: ClientRequest, method: string, body: RequestInit["body"]): void {
  if (body == null || method === "GET" || method === "HEAD") {
    req.end();
  } else if (typeof body === "string") {
    req.end(body);
  } else if (body instanceof Uint8Array) {
    req.end(Buffer.from(body));
  } else if (body instanceof ReadableStream) {
    writeReadableStreamBody(req, body);
  } else {
    req.end(String(body));
  }
}

async function writeReadableStreamBody(
  req: ClientRequest,
  body: ReadableStream<unknown>,
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        req.end();
        return;
      }
      if (!req.write(Buffer.from(toUint8ArrayChunk(value)))) {
        await new Promise<void>((resolve) => req.once("drain", resolve));
      }
    }
  } catch (error) {
    req.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    reader.releaseLock();
  }
}

function nextRedirectInit(init: RequestInit, status: number): RequestInit {
  // 307/308 preserve the method and body; 301/302/303 downgrade to a bodyless
  // GET (the conservative, widely-compatible behaviour browsers use for POST).
  if (status === 307 || status === 308) {
    return init;
  }
  const { body: _body, ...rest } = init;
  return { ...rest, method: "GET" };
}

/**
 * SSRF-hardened replacement for `fetch()` against operator/user-supplied URLs.
 *
 * Each hop is validated with the shared outbound-URL guards
 * ({@link resolveSafeOutboundTarget}) and, on Node, the connection is pinned to
 * the validated IP so it cannot re-resolve into a private/reserved range
 * (169.254.169.254, 10.x, the headscale mesh, …) between validation and
 * connect. Redirects are followed manually so every hop is re-validated and
 * re-pinned.
 *
 * `init.redirect` is honoured like the platform fetch:
 *   - `"follow"` (default): follow up to {@link DEFAULT_MAX_REDIRECTS} hops,
 *     re-validating + re-pinning each one;
 *   - `"manual"`: return the redirect response without following;
 *   - `"error"`: reject if the target responds with a redirect.
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const redirectMode = init.redirect ?? "follow";
  let currentUrl = rawUrl;
  let currentInit = init;

  for (let hop = 0; ; hop += 1) {
    // Validate (resolve DNS + screen every address) on every hop in both
    // runtimes. On Node we then pin the connection to the validated IP; on
    // workerd we cannot pin an arbitrary IP, so the platform fetch re-resolves
    // — a residual rebinding window documented on canPinSockets().
    const { url, address, family } = await resolveSafeOutboundTarget(currentUrl);
    const response = canPinSockets()
      ? await nodePinnedFetch(url, address, family, { ...currentInit, redirect: "manual" })
      : await fetch(url.toString(), { ...currentInit, redirect: "manual" });

    if (!REDIRECT_STATUSES.has(response.status) || redirectMode === "manual") {
      return response;
    }

    if (redirectMode === "error") {
      throw new Error(
        `Outbound request was redirected (${response.status}) but redirects are not allowed`,
      );
    }

    if (hop >= DEFAULT_MAX_REDIRECTS) {
      throw new Error("Too many redirects");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error("Redirect response missing Location header");
    }

    // Free the socket before re-issuing the request.
    await response.body?.cancel().catch(() => {});

    currentUrl = new URL(location, currentUrl).toString();
    currentInit = nextRedirectInit(currentInit, response.status);
  }
}
