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
import {
  type IncomingMessage,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";

import {
  type AgentRuntime,
  type IAgentRuntime,
  type LegacyRouteHandler,
  type PaymentEnabledRoute,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
  type RuntimeRouteHostContext,
  setRuntimeRouteHostContext,
} from "@elizaos/core";
import {
  createPaymentAwareHandler,
  isRoutePaymentWrapped,
} from "@elizaos/plugin-x402";

import { matchPluginRoutePath } from "./runtime-plugin-routes.ts";

export interface DispatchRouteArgs {
  runtime: IAgentRuntime | AgentRuntime | null | undefined;
  method: string;
  path: string;
  headers: Record<string, string>;
  query?: Record<string, string | string[]>;
  /** Raw body: string, Buffer, or already-parsed JSON object/array. */
  body?: unknown;
  /** true when invoked in-process via IPC; false when invoked over HTTP. */
  inProcess: boolean;
  isAuthorized: () => boolean;
  /** Optional host context (config, restartRuntime, etc.) — installed on the runtime for the duration of the dispatch. */
  hostContext?: RuntimeRouteHostContext;
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
  const readable = Readable.from(bodyText ? [Buffer.from(bodyText, "utf8")] : []);
  const req = readable as unknown as IncomingMessage & {
    query: Record<string, string | string[]>;
    params: Record<string, string>;
    protocol: string;
    path: string;
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body?: unknown;
    get: (name: string) => string | undefined;
  };
  req.headers = incomingHeaders;
  req.method = args.method;
  req.url = args.path;
  req.path = args.path;
  req.protocol = "http";
  req.query = args.query;
  req.params = args.params;
  req.body = parseBodyAsJson(args.body);
  req.get = (name: string) => {
    const v = incomingHeaders[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : (v as string | undefined);
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
    if (typeof chunk === "string") {
      captured.chunks.push(Buffer.from(chunk, "utf8"));
    } else if (Buffer.isBuffer(chunk)) {
      captured.chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      captured.chunks.push(Buffer.from(chunk));
    } else {
      captured.chunks.push(Buffer.from(String(chunk), "utf8"));
    }
  };

  // Build a minimal ServerResponse-ish object. We intentionally cast through
  // `unknown` because we only emulate the surface area that plugin handlers
  // actually reach for (status/json/send/setHeader/end/write/headersSent).
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
      return res as unknown as ServerResponse;
    },
    status(code: number) {
      this.statusCode = code;
      captured.statusCode = code;
      return {
        json(data: unknown) {
          if (captured.ended) return;
          captured.headers["content-type"] =
            captured.headers["content-type"] ?? "application/json; charset=utf-8";
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
    res: res as unknown as ServerResponse,
    captured,
  };
}

function capturedToResult(captured: CapturedResponse): RouteHandlerResult {
  const buffer = Buffer.concat(captured.chunks);
  const contentType = captured.headers["content-type"] ?? "";
  let body: unknown = buffer.length > 0 ? buffer.toString("utf8") : undefined;
  if (
    body != null &&
    typeof body === "string" &&
    contentType.toLowerCase().includes("application/json")
  ) {
    try {
      body = JSON.parse(body);
    } catch {
      // keep as string
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
          params,
          query,
          headers,
          method,
          path: args.path,
          runtime: runtime as IAgentRuntime,
          inProcess: args.inProcess,
        };
        return await route.routeHandler(ctx);
      }

      // Legacy Express-shaped handler — run through the synthetic shim so we
      // can capture the response into a structured RouteHandlerResult.
      const legacyHandler = route.handler as LegacyRouteHandler;
      const effectiveHandler =
        route.x402 != null && !isRoutePaymentWrapped(route)
          ? createPaymentAwareHandler(route as PaymentEnabledRoute)
          : legacyHandler;

      const { req, res, captured } = buildLegacyShim({
        method,
        path: args.path,
        headers,
        query,
        params,
        body: args.body,
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
