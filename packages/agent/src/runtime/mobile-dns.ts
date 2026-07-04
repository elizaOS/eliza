/**
 * Points the on-device agent's DNS at public resolvers when it runs on a mobile
 * platform, where Android/iOS expose no /etc/resolv.conf for the musl-linked bun
 * process to read. configureMobileDnsIfNeeded() installs three cooperating layers
 * — dns.setServers, a dns.lookup patch backed by an explicit-server resolver, and
 * a globalThis.fetch wrapper that routes external requests through node:http(s)
 * (which honors the custom lookup) — so outbound cloud/inference/connector calls
 * resolve. Idempotent and a no-op off mobile; loopback and IP literals always
 * bypass the overrides.
 */
import dns, { type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { isMobilePlatform } from "@elizaos/shared";

/**
 * Public resolvers the on-device agent dials directly. Android/iOS expose no
 * `/etc/resolv.conf` (DNS is brokered by the OS resolver — netd on Android),
 * which the musl-linked bun agent process can't use, so without explicit
 * nameservers every outbound request (cloud auth/inference, model catalog,
 * connector APIs) fails with "Unable to connect. Is the computer able to access
 * the url?". Cloudflare + Google, so a single provider outage doesn't strand the
 * agent.
 */
const MOBILE_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"] as const;

let configured = false;

/** A real external hostname needing resolution (not an IP literal or loopback). */
function needsResolution(hostname: string): boolean {
  if (!hostname) return false;
  if (net.isIP(hostname) !== 0) return false;
  return hostname !== "localhost";
}

/**
 * Point the agent's DNS at public resolvers when running on a mobile device that
 * has no system resolv.conf. Idempotent; a no-op on every non-mobile platform.
 *
 * Three layers, because Bun resolves over multiple paths:
 *  1. `dns.setServers` on the default resolver — `dns.resolve*` consumers.
 *  2. a `dns.lookup` / `dns.promises.lookup` patch backed by an explicit-server
 *     resolver — undici/`http(s).Agent` consumers that resolve via `lookup`.
 *     IP literals and `localhost` pass straight through so loopback (the agent's
 *     own API + the device bridge) is untouched.
 *  3. a `globalThis.fetch` wrapper that routes EXTERNAL https/http hostnames
 *     through `node:https`/`node:http` with the explicit-server `lookup`. Bun's
 *     native `fetch` ignores layers 1+2 (it reads only `/etc/resolv.conf`), but
 *     `node:https` honors a custom `lookup` — the same mechanism the model
 *     downloader already relies on. Loopback/IP requests keep using native fetch.
 */
export function configureMobileDnsIfNeeded(): void {
  if (configured || !isMobilePlatform()) return;
  configured = true;

  try {
    dns.setServers([...MOBILE_DNS_SERVERS]);
  } catch {
    // older/locked-down resolvers may reject setServers; layers 2+3 cover us.
  }

  const resolver = new dns.Resolver();
  try {
    resolver.setServers([...MOBILE_DNS_SERVERS]);
  } catch {
    return;
  }

  const lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: unknown,
      family?: number,
    ) => void;
    const opts = (typeof options === "function" ? {} : (options ?? {})) as {
      all?: boolean;
    };
    const literal = net.isIP(hostname);
    const direct =
      literal !== 0
        ? { address: hostname, family: literal }
        : hostname === "localhost"
          ? { address: "127.0.0.1", family: 4 }
          : null;
    if (direct) {
      cb(
        null,
        opts.all
          ? [{ address: direct.address, family: direct.family }]
          : direct.address,
        direct.family,
      );
      return;
    }
    resolver.resolve4(hostname, (error, addresses) => {
      if (error || addresses.length === 0) {
        cb(
          error ??
            Object.assign(new Error(`No A record for ${hostname}`), {
              code: "ENOTFOUND",
            }),
          undefined,
          undefined,
        );
        return;
      }
      cb(
        null,
        opts.all
          ? addresses.map((address) => ({ address, family: 4 }))
          : addresses[0],
        4,
      );
    });
  }) as typeof dns.lookup;

  dns.lookup = lookup;
  dns.promises.lookup = ((hostname: string, options?: { all?: boolean }) =>
    new Promise((resolve, reject) => {
      lookup(
        hostname,
        options ?? {},
        (
          err: NodeJS.ErrnoException | null,
          address: unknown,
          family?: number,
        ) => {
          if (err) reject(err);
          else
            resolve(
              (options?.all ? address : { address, family }) as
                | LookupAddress[]
                | LookupAddress,
            );
        },
      );
    })) as typeof dns.promises.lookup;

  installFetchOverNodeHttp(lookup);
}

/**
 * Replace `globalThis.fetch` for external hostnames with a `node:http(s)`-backed
 * implementation that honors the custom DNS `lookup`. Loopback/IP requests fall
 * through to the original native fetch.
 */
function installFetchOverNodeHttp(lookup: typeof dns.lookup): void {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;

  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let url: URL;
    try {
      url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : (input as Request).url);
    } catch {
      return nativeFetch(input as RequestInfo, init);
    }
    const isHttp = url.protocol === "https:" || url.protocol === "http:";
    if (!isHttp || !needsResolution(url.hostname)) {
      return nativeFetch(input as RequestInfo, init);
    }
    return fetchViaNode(url, input, init, lookup, 0);
  };
  // Carry over `fetch.preconnect` so the wrapper still satisfies `typeof fetch`.
  globalThis.fetch = Object.assign(wrapped, {
    preconnect: nativeFetch.preconnect.bind(nativeFetch),
  });
}

async function fetchViaNode(
  url: URL,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  lookup: typeof dns.lookup,
  redirectCount: number,
): Promise<Response> {
  if (redirectCount > 8) throw new TypeError("Too many redirects");

  // Merge init with a Request input (init wins), so callers passing a Request work.
  const req =
    input instanceof Request && !(input instanceof URL) ? input : undefined;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? req?.headers ?? undefined);
  const signal = init?.signal ?? req?.signal ?? undefined;

  // Buffer the request body (agent payloads are small JSON/text).
  let body: Buffer | undefined;
  const rawBody =
    init?.body ?? (req ? await req.clone().arrayBuffer() : undefined);
  if (rawBody != null && method !== "GET" && method !== "HEAD") {
    if (typeof rawBody === "string") body = Buffer.from(rawBody);
    else if (rawBody instanceof ArrayBuffer) body = Buffer.from(rawBody);
    else if (ArrayBuffer.isView(rawBody))
      body = Buffer.from(
        rawBody.buffer,
        rawBody.byteOffset,
        rawBody.byteLength,
      );
    else
      body = Buffer.from(await new Response(rawBody as BodyInit).arrayBuffer());
    if (!headers.has("content-length"))
      headers.set("content-length", String(body.length));
  }

  const transport = url.protocol === "https:" ? https : http;
  const headerObj: Record<string, string> = {};
  headers.forEach((v, k) => {
    headerObj[k] = v;
  });

  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      request.destroy(
        new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    const request = transport.request(
      url,
      { method, headers: headerObj, lookup },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (location && [301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const nextUrl = new URL(location, url);
          const nextInit: RequestInit = { ...init, headers: headerObj };
          // Carry the abort signal across the redirect (the original may have
          // arrived as a Request, so init.signal can be absent).
          if (signal) nextInit.signal = signal;
          if (
            status === 303 ||
            ((status === 301 || status === 302) && method === "POST")
          ) {
            // Redirect-to-GET: drop the body AND its now-wrong framing headers,
            // otherwise the next GET advertises a Content-Length with no body
            // and mis-frames the connection.
            nextInit.method = "GET";
            delete (nextInit as { body?: unknown }).body;
            delete headerObj["content-length"];
            delete headerObj["content-type"];
          } else {
            // Body-preserving redirect (307/308, or a non-POST 301/302): carry
            // the resolved method and the already-buffered body forward — they
            // may have come from a Request object, so init.method/body are unset
            // and would otherwise silently degrade to an empty GET.
            nextInit.method = method;
            // Copy into a fresh-ArrayBuffer Uint8Array so it satisfies BodyInit
            // (a Buffer is ArrayBufferLike-backed); payloads here are small.
            if (body) nextInit.body = new Uint8Array(body);
          }
          resolve(
            fetchViaNode(nextUrl, nextUrl, nextInit, lookup, redirectCount + 1),
          );
          return;
        }

        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const decoded =
          enc === "gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : res;

        const respHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          // strip hop-by-hop / now-invalid framing headers after decode
          if (
            [
              "content-encoding",
              "content-length",
              "transfer-encoding",
            ].includes(k)
          )
            continue;
          for (const item of Array.isArray(v) ? v : [v])
            respHeaders.append(k, item);
        }

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            decoded.on("data", (chunk: Buffer) =>
              controller.enqueue(new Uint8Array(chunk)),
            );
            decoded.on("end", () => controller.close());
            decoded.on("error", (err: Error) => controller.error(err));
          },
          cancel() {
            res.destroy();
          },
        });

        const response = new Response(
          status === 204 || status === 304 ? null : stream,
          {
            status,
            statusText: res.statusMessage ?? "",
            headers: respHeaders,
          },
        );
        Object.defineProperty(response, "url", { value: url.toString() });
        resolve(response);
      },
    );

    request.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        // `{ once: true }` only detaches after firing; for a request that
        // completes normally the listener would leak on the (long-lived)
        // caller signal, so remove it when the request settles.
        request.on("close", () => {
          signal.removeEventListener("abort", onAbort);
        });
      }
    }
    if (body) request.write(body);
    request.end();
  });
}
