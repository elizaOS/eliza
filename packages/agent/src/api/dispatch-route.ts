/**
 * Canonical plugin-route dispatcher used by both the HTTP server and the
 * in-process (IPC) bridge.
 *
 * Both transports converge on this function so that one route definition in
 * `runtime.routes` serves both worlds:
 *
 *   HTTP (Hono / Node http)  ─┐
 *                              ├─→ dispatchRoute() ─→ Route.routeHandler (new)
 *   IPC (Bun ↔ Swift bridge) ─┘                    └→ Route.handler      (legacy Express shim)
 *
 * The legacy Express-style `handler` field is supported via a synthetic
 * `IncomingMessage` / `ServerResponse` shim that captures the response into
 * a {@link RouteHandlerResult}. New plugin routes should prefer
 * `routeHandler` which returns the result directly.
 */

import { Buffer } from "node:buffer";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

import {
  type AccessContext,
  type AgentRuntime,
  assertPublicRouteIntent,
  type IAgentRuntime,
  type LegacyRouteHandler,
  logger,
  type PaymentEnabledRoute,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
  type RuntimeRouteHostContext,
  setRuntimeRouteHostContext,
} from "@elizaos/core";

// `@elizaos/plugin-x402` is optional: it is a desktop/cloud-only plugin and is
// aliased to a null stub in the mobile agent bundle. Mirror the guarded loader
// in api/server.ts (`getX402Plugin`) so a declared x402 route degrades to its
// unwrapped handler instead of throwing:
//   - not installed  → the dynamic import rejects → `.catch(() => null)`
//   - mobile stub    → module loads but exports are no-op proxies whose
//     `__mobileStub` flag is set and whose "functions" return `undefined`,
//     so calling `createPaymentAwareHandler` would yield `undefined` and the
//     subsequent invocation would be an unhandled TypeError.
// A `null` result means "no usable payment wrapper" — callers fall through to
// the unwrapped legacy handler.
type X402PluginModule = typeof import("@elizaos/plugin-x402");

/**
 * Vet a resolved `@elizaos/plugin-x402` module: return it only when it exposes
 * usable payment helpers, otherwise `null`. The mobile bundle aliases the
 * plugin to a null stub whose exports are no-op proxies (flagged
 * `__mobileStub`), so `createPaymentAwareHandler` would return `undefined` and
 * calling it would throw. Exported for unit testing against the real stub.
 */
export function vetX402Module(mod: unknown): X402PluginModule | null {
  if (mod == null) return null;
  if ((mod as { __mobileStub?: boolean }).__mobileStub) return null;
  const candidate = mod as Partial<X402PluginModule>;
  if (
    typeof candidate.createPaymentAwareHandler !== "function" ||
    typeof candidate.isRoutePaymentWrapped !== "function"
  ) {
    return null;
  }
  return candidate as X402PluginModule;
}

/**
 * Pick the handler an x402-declaring route should run. When no usable payment
 * wrapper is available (`x402 === null`: plugin absent or mobile stub), fall
 * through to the unwrapped legacy handler so the route serves a deliberate
 * response instead of throwing. Exported for unit testing the fall-through.
 */
export function selectX402Handler(
  x402: X402PluginModule | null,
  route: Route,
  legacyHandler: LegacyRouteHandler,
): LegacyRouteHandler {
  if (!x402) return legacyHandler;
  if (x402.isRoutePaymentWrapped(route)) return legacyHandler;
  return x402.createPaymentAwareHandler(
    route as PaymentEnabledRoute,
  ) as LegacyRouteHandler;
}

let x402PluginModule: X402PluginModule | null = null;
let x402PluginModulePromise: Promise<X402PluginModule | null> | null = null;

function importOptionalX402Plugin(): Promise<unknown> {
  // Variable specifier keeps Vite's import-analysis from eagerly resolving the
  // optional plugin's dist (which is absent in the unit lane / mobile bundle).
  const specifier = "@elizaos/plugin-x402";
  return import(/* @vite-ignore */ specifier);
}

async function getX402Plugin(): Promise<X402PluginModule | null> {
  if (x402PluginModule) return x402PluginModule;
  x402PluginModulePromise ??= importOptionalX402Plugin()
    .then((mod) => {
      const vetted = vetX402Module(mod);
      if (vetted) x402PluginModule = vetted;
      return vetted;
    })
    .catch(() => null);
  return x402PluginModulePromise;
}

function matchPluginRoutePath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const norm = (p: string) => p.split("/").filter((s) => s.length > 0);
  const pSegs = norm(pattern);
  const pathSegs = norm(pathname);
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i];
    const c = pathSegs[i];
    if (!p) return null;
    if (p.startsWith(":") && p.endsWith("*")) {
      const key = p.slice(1, -1);
      const tail = pathSegs.slice(i).join("/");
      if (!tail) return null;
      try {
        params[key] = decodeURIComponent(tail);
      } catch {
        params[key] = tail;
      }
      return params;
    }
    if (c === undefined) return null;
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(c);
      } catch {
        params[p.slice(1)] = c;
      }
    } else if (p !== c) {
      return null;
    }
  }
  return pSegs.length === pathSegs.length ? params : null;
}

export interface DispatchRouteArgs {
  runtime: IAgentRuntime | AgentRuntime | null | undefined;
  method: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, string | string[]>;
  /** Raw body: string, Buffer, or already-parsed JSON object/array. */
  body?: unknown;
  /** Preserved raw UTF-8 body for webhook HMAC verification (when JSON was parsed). */
  rawBody?: string;
  /** true when invoked in-process via IPC; false when invoked over HTTP. */
  inProcess: boolean;
  isAuthorized: () => boolean;
  /** true when the transport verified a trusted loopback/local request. */
  isTrustedLocal?: () => boolean;
  /**
   * Requester identity resolved by the authenticated boundary (e.g. a
   * registered TokenRoleResolver principal, #14781). Omitted for the
   * single-owner local boundary, where routes must preserve their existing
   * unfiltered behavior (see `RouteHandlerContext.accessContext`).
   */
  accessContext?: AccessContext;
  /** Optional host context (config, restartRuntime, etc.) — installed on the runtime for the duration of the dispatch. */
  hostContext?: RuntimeRouteHostContext;
  /**
   * Optional incremental sink for a legacy SSE handler's body writes. When set,
   * every `res.write(...)` chunk is forwarded the instant the handler flushes it
   * — so an in-process transport (stdio bridge) delivers token frames as they
   * arrive instead of only after `res.end()`. The buffered `RouteHandlerResult`
   * is still returned on completion (with the full body) for callers that ignore
   * the sink. Unset over HTTP, where the socket already flushes incrementally.
   */
  onChunk?: (chunk: Buffer) => void;
}

/** Lowercase normalize a header map. */
function normalizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
  }
  return out;
}

function toIncomingHttpHeaders(
  headers: Record<string, string>,
): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** Coerce an arbitrary body into the JSON-decoded form Express handlers expect on `req.body`. */
function parseBodyAsJson(body: unknown): unknown {
  if (body == null) return undefined;
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return body;
    }
  }
  if (Buffer.isBuffer(body)) {
    const text = body.toString("utf8").trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return body;
    }
  }
  return body;
}

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  ended: boolean;
}

function asCapturedServerResponse(res: unknown): ServerResponse {
  return res as ServerResponse;
}

/**
 * Builds a synthetic `IncomingMessage` / `ServerResponse` pair that legacy
 * Express-shaped route handlers can write to. The captured response is
 * returned as a {@link RouteHandlerResult}.
 */
function buildLegacyShim(args: {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  params: Record<string, string>;
  body: unknown;
  rawBody?: string;
  onChunk?: (chunk: Buffer) => void;
}): { req: IncomingMessage; res: ServerResponse; captured: CapturedResponse } {
  const incomingHeaders = toIncomingHttpHeaders(args.headers);
  // Provide a readable stream body so handlers that call req.on('data') still work.
  const bodyText = (() => {
    if (args.body == null) return "";
    if (typeof args.body === "string") return args.body;
    if (Buffer.isBuffer(args.body)) return args.body.toString("utf8");
    try {
      return JSON.stringify(args.body);
    } catch {
      return "";
    }
  })();
  const readable = Readable.from(
    bodyText ? [Buffer.from(bodyText, "utf8")] : [],
  );
  const req = readable as IncomingMessage & {
    query: Record<string, string | string[]>;
    params: Record<string, string>;
    protocol: string;
    path: string;
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body?: unknown;
    rawBody?: string;
    get: (name: string) => string | undefined;
  };
  req.headers = incomingHeaders;
  req.method = args.method;
  req.url = args.path;
  req.path = args.path;
  req.protocol = "http";
  req.query = args.query;
  req.params = args.params;
  if (typeof args.body === "string") {
    req.rawBody = args.rawBody ?? args.body;
    req.body = parseBodyAsJson(args.body);
  } else if (Buffer.isBuffer(args.body)) {
    const text = args.body.toString("utf8");
    req.rawBody = args.rawBody ?? text;
    req.body = parseBodyAsJson(text);
  } else {
    req.rawBody = args.rawBody;
    req.body = parseBodyAsJson(args.body);
  }
  req.get = (name: string) => {
    const v = incomingHeaders[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };

  const captured: CapturedResponse = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
  };

  const setHeader = (name: string, value: string | number | string[]): void => {
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    captured.headers[name.toLowerCase()] = text;
  };

  const writeChunk = (chunk: unknown): void => {
    if (chunk == null) return;
    let buf: Buffer;
    if (typeof chunk === "string") {
      buf = Buffer.from(chunk, "utf8");
    } else if (Buffer.isBuffer(chunk)) {
      buf = chunk;
    } else if (chunk instanceof Uint8Array) {
      buf = Buffer.from(chunk);
    } else {
      buf = Buffer.from(String(chunk), "utf8");
    }
    captured.chunks.push(buf);
    // Forward to the incremental sink the instant the handler flushes, so an
    // in-process streaming transport can emit token frames as they arrive.
    args.onChunk?.(buf);
  };

  // Build a minimal ServerResponse-ish object. Plugin handlers only reach for
  // this subset (status/json/send/setHeader/end/write/headersSent), so the
  // structural boundary is isolated in asCapturedServerResponse().
  const res = {
    statusCode: 200,
    get headersSent() {
      return captured.ended;
    },
    setHeader,
    getHeader: (name: string) => captured.headers[name.toLowerCase()],
    removeHeader: (name: string) => {
      delete captured.headers[name.toLowerCase()];
    },
    write: (chunk: unknown) => {
      writeChunk(chunk);
      return true;
    },
    end: (chunk?: unknown) => {
      if (chunk != null) writeChunk(chunk);
      captured.ended = true;
      return asCapturedServerResponse(res);
    },
    status(code: number) {
      this.statusCode = code;
      captured.statusCode = code;
      return {
        json(data: unknown) {
          if (captured.ended) return;
          captured.headers["content-type"] =
            captured.headers["content-type"] ??
            "application/json; charset=utf-8";
          writeChunk(JSON.stringify(data));
          captured.ended = true;
        },
        send(data: unknown) {
          if (captured.ended) return;
          if (typeof data === "string" || Buffer.isBuffer(data)) {
            writeChunk(data);
          } else {
            captured.headers["content-type"] =
              captured.headers["content-type"] ??
              "application/json; charset=utf-8";
            writeChunk(JSON.stringify(data));
          }
          captured.ended = true;
        },
      };
    },
    json(data: unknown) {
      if (captured.ended) return res;
      captured.headers["content-type"] =
        captured.headers["content-type"] ?? "application/json; charset=utf-8";
      writeChunk(JSON.stringify(data));
      captured.ended = true;
      return res;
    },
    send(data: unknown) {
      if (captured.ended) return res;
      if (typeof data === "string" || Buffer.isBuffer(data)) {
        writeChunk(data);
      } else if (data != null) {
        captured.headers["content-type"] =
          captured.headers["content-type"] ?? "application/json; charset=utf-8";
        writeChunk(JSON.stringify(data));
      }
      captured.ended = true;
      return res;
    },
  };
  // Mirror statusCode writes from the handler onto the captured value.
  Object.defineProperty(res, "statusCode", {
    get() {
      return captured.statusCode;
    },
    set(v: number) {
      captured.statusCode = v;
    },
    configurable: true,
  });

  return {
    req,
    res: asCapturedServerResponse(res),
    captured,
  };
}

function capturedToResult(captured: CapturedResponse): RouteHandlerResult {
  const buffer = Buffer.concat(captured.chunks);
  const contentType = (captured.headers["content-type"] ?? "").toLowerCase();
  const contentEncoding = (captured.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  if (buffer.length === 0) {
    return {
      status: captured.statusCode || 200,
      headers: captured.headers,
      body: undefined,
    };
  }
  // Content encodings describe bytes that the client must decode even when the
  // underlying media type is textual; interpreting either encoded or binary
  // bytes as UTF-8 would make the downstream IPC base64 envelope lossy.
  const hasTransferEncoding =
    contentEncoding !== "" && contentEncoding !== "identity";
  const isTextual =
    !hasTransferEncoding &&
    (contentType === "" ||
      contentType.startsWith("text/") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType.includes("x-www-form-urlencoded") ||
      contentType.includes("charset"));
  if (!isTextual) {
    return {
      status: captured.statusCode || 200,
      headers: captured.headers,
      body: buffer,
    };
  }
  const text = buffer.toString("utf8");
  let body: unknown = text;
  if (contentType.includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      // error-policy:J3 malformed JSON stays explicit raw text at this transport boundary
    }
  }
  return {
    status: captured.statusCode || 200,
    headers: captured.headers,
    body,
  };
}

/**
 * Dispatch a single request against `runtime.routes`. Returns `null` when no
 * matching route is found. The caller is responsible for sending the result
 * back over whatever transport (HTTP response, IPC frame, etc.).
 */
export async function dispatchRoute(
  args: DispatchRouteArgs,
): Promise<RouteHandlerResult | null> {
  const runtime = args.runtime;
  if (!runtime?.routes?.length) return null;

  const method = args.method.toUpperCase();
  const headers = normalizeHeaders(args.headers);
  const query = args.query ?? {};

  for (const route of runtime.routes as Route[]) {
    assertPublicRouteIntent(route, "runtime.routes");
    if (route.type === "STATIC") continue;
    if (route.type !== method) continue;
    if (!route.handler && !route.routeHandler) continue;

    const params = matchPluginRoutePath(route.path, args.path);
    if (params === null) continue;

    if (route.public !== true && !args.isAuthorized()) {
      return {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { error: "Unauthorized" },
      };
    }

    const restoreHostContext = args.hostContext
      ? setRuntimeRouteHostContext(runtime, args.hostContext)
      : undefined;

    try {
      // New return-shape handler — preferred path.
      if (route.routeHandler) {
        const ctx: RouteHandlerContext = {
          body: parseBodyAsJson(args.body),
          rawBody: args.rawBody,
          params,
          query,
          headers,
          method,
          path: args.path,
          runtime: runtime as IAgentRuntime,
          inProcess: args.inProcess,
          isTrustedLocal: args.isTrustedLocal?.() ?? false,
          ...(args.accessContext ? { accessContext: args.accessContext } : {}),
        };
        return await route.routeHandler(ctx);
      }

      // Legacy Express-shaped handler — run through the synthetic shim so we
      // can capture the response into a structured RouteHandlerResult.
      const legacyHandler = route.handler as LegacyRouteHandler;
      let effectiveHandler = legacyHandler;
      if (route.x402 != null) {
        const x402 = await getX402Plugin();
        if (!x402) {
          // x402 plugin unavailable (mobile stub / not installed). Serve the
          // route with its unwrapped handler rather than 500-ing; payment
          // enforcement is inert where the plugin is not present.
          logger.debug(
            `[dispatchRoute] x402 plugin unavailable; serving ${method} ${args.path} without payment enforcement`,
          );
        }
        effectiveHandler = selectX402Handler(x402, route, legacyHandler);
      }

      const { req, res, captured } = buildLegacyShim({
        method,
        path: args.path,
        headers,
        query,
        params,
        body: args.body,
        rawBody: args.rawBody,
        onChunk: args.onChunk,
      });

      try {
        await effectiveHandler(
          req as never,
          res as never,
          runtime as IAgentRuntime,
        );
      } catch (err) {
        if (!captured.ended) {
          return {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: {
              error:
                err instanceof Error ? err.message : "Internal server error",
            },
          };
        }
        // Handler partially wrote; surface what we have.
      }
      return capturedToResult(captured);
    } finally {
      restoreHostContext?.();
    }
  }

  return null;
}
