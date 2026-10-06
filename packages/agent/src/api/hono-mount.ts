import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type AccessContext,
  ElizaError,
  type IAgentRuntime,
} from "@elizaos/core";
import { getHttpRuntime, type Route } from "@elizaos/host/protocol";

import type { Hono } from "hono";
import { buildHonoAppForRuntime } from "./hono-adapter.ts";
import { isAuthenticatedInProcessRequest } from "./in-process-request.ts";
import { matchPluginRoutePath } from "./plugin-route-path.ts";

/**
 * Bridge between Node's `http.IncomingMessage` / `ServerResponse` and a Hono
 * app. Lets the existing raw-Node server hand requests off to Hono for the
 * subset of routes that go through `runtime.routes`.
 */
interface RuntimeHonoCache {
  signature: string;
  app: Hono;
}
const apps = new WeakMap<IAgentRuntime, RuntimeHonoCache>();
const requestContexts = new WeakMap<
  Request,
  {
    authorized: boolean;
    inProcess: boolean;
    trustedLocal: boolean;
    accessContext?: AccessContext;
  }
>();
function getHonoApp(runtime: IAgentRuntime): Hono {
  const signature = JSON.stringify(
    getHttpRuntime(runtime).routes.map((route) => [
      route.type,
      route.path,
      Boolean(route.handler || route.routeHandler),
    ]),
  );
  const cached = apps.get(runtime);
  if (cached?.signature === signature) {
    return cached.app;
  }
  const app = buildHonoAppForRuntime(runtime, {
    inProcess: (req) => requestContexts.get(req)?.inProcess === true,
    isAuthorized: (req) => requestContexts.get(req)?.authorized === true,
    isTrustedLocal: (req) => requestContexts.get(req)?.trustedLocal === true,
    resolveAccessContext: (req) => requestContexts.get(req)?.accessContext,
  });
  apps.set(runtime, { signature, app });
  return app;
}
// Matches the 1 MiB cap applied to the sibling JSON/body readers in
// server.ts (MAX_BODY_BYTES). The Hono fallback path never goes through that
// reader, so it needs its own guard: without it a POST to any Hono-eligible
// plugin routeHandler with an unbounded body is fully buffered into an
// ArrayBuffer with no 413, hanging or OOM-ing the process.
export const DEFAULT_MAX_HONO_BODY_BYTES = 1024 * 1024; // 1 MiB
interface ReadNodeBodyResult {
  body: ArrayBuffer | null;
  tooLarge: boolean;
}
async function readNodeBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<ReadNodeBodyResult> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { body: null, tooLarge: false };
  }
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    // Drain without retaining bytes so the peer can finish its write and read
    // the 413 response. Pausing or destroying here turns a valid HTTP rejection
    // into EPIPE/ECONNRESET for clients that are still sending the declared body.
    req.resume();
    return { body: null, tooLarge: true };
  }
  return new Promise<ReadNodeBodyResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error("Request body was aborted"));
    const onEnd = () => {
      cleanup();
      if (chunks.length === 0) {
        resolve({ body: null, tooLarge: false });
        return;
      }
      const concatenated = Buffer.concat(chunks, total);
      const body = new ArrayBuffer(concatenated.byteLength);
      new Uint8Array(body).set(concatenated);
      resolve({ body, tooLarge: false });
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBodyBytes) {
        cleanup();
        // Stop retaining bytes but keep draining the request. This preserves the
        // memory cap while allowing a real client to receive the promised 413.
        req.resume();
        resolve({ body: null, tooLarge: true });
        return;
      }
      chunks.push(buf);
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}
function nodeHeadersToWeb(headers: IncomingMessage["headers"]): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, value);
    }
  }
  return out;
}
async function pipeWebBodyToNodeResponse(
  body: ReadableStream<Uint8Array>,
  res: ServerResponse,
  signal: AbortSignal,
  runtime: IAgentRuntime,
): Promise<void> {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch((error: unknown) => {
      // error-policy:J6 Cancellation cleanup failures remain observable.
      runtime.reportError("http.pluginStream.cancel", error);
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        res.end();
        return;
      }
      if (!res.write(Buffer.from(value))) await once(res, "drain", { signal });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Normalize a request pathname to the same shape the canonical
 * `matchPluginRoutePath` matcher tolerates (it splits on `/` and drops empty
 * segments, so duplicate and trailing slashes are ignored). Hono's router is
 * strict about both, so without this a path like `/api/foo/` passes the
 * tolerant `hasHonoEligibleRoute` gate below, then 404s inside Hono — the
 * request is swallowed with a 404 even though `dispatchRoute` (the canonical
 * dispatcher, used by the in-process IPC surface) serves the same path.
 */
function normalizeRoutePathname(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/")
    ? collapsed.slice(0, -1)
    : collapsed;
}
function findHonoEligibleRoute(
  runtime: IAgentRuntime,
  method: string,
  pathname: string,
): Route | null {
  const upper = method.toUpperCase();
  for (const route of getHttpRuntime(runtime).routes as Route[]) {
    if (route.type === "STATIC") continue;
    if (route.type !== upper) continue;
    if (!route.routeHandler) continue;
    if (matchPluginRoutePath(route.path, pathname) === null) continue;
    return route;
  }
  return null;
}
export async function tryHandleHonoRuntimeRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  runtime: IAgentRuntime | null | undefined;
  isAuthorized: () => boolean;
  isTrustedLocal?: () => boolean;
  /** Boundary-resolved requester identity for per-viewer DTO selection (#14781). */
  accessContext?: () => AccessContext | undefined;
}): Promise<boolean> {
  const { req, res, runtime } = options;
  if (!runtime || !getHttpRuntime(runtime).routes.length) return false;
  const method = req.method ?? "GET";
  const requestUrl = req.url ?? "/";
  const pathname = normalizeRoutePathname(
    (() => {
      try {
        return new URL(requestUrl, `http://${req.headers.host ?? "localhost"}`)
          .pathname;
      } catch {
        return requestUrl.split("?")[0] ?? "/";
      }
    })(),
  );
  const matchedRoute = findHonoEligibleRoute(runtime, method, pathname);
  if (!matchedRoute) {
    return false;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const disconnected = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", disconnected);
  if (req.aborted || res.destroyed) abort();
  try {
    controller.signal.throwIfAborted();
    const app = getHonoApp(runtime);
    const maxBodyBytes =
      matchedRoute.maxBodyBytes ?? DEFAULT_MAX_HONO_BODY_BYTES;
    const { body: bodyBytes, tooLarge } = await readNodeBody(req, maxBodyBytes);
    if (tooLarge) {
      // The request body exceeded this route's cap. Respond 413 without
      // dispatching to Hono. Remaining bytes are discarded without retention.
      res.statusCode = 413;
      res.setHeader("content-type", "application/json");
      res.setHeader("connection", "close");
      res.end(
        JSON.stringify({
          error: "Request body too large",
          maxBytes: maxBodyBytes,
        }),
      );
      return true;
    }
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    // Hand Hono the normalized path so its strict router agrees with the
    // tolerant eligibility gate above (and with dispatchRoute inside the
    // handler, which re-matches against the same normalized path).
    url.pathname = pathname;
    const headers = nodeHeadersToWeb(req.headers);
    // Hono needs a Web Request. Avoid leaking the body to GET/HEAD.
    const request = new Request(url, {
      signal: controller.signal,
      method: req.method ?? "GET",
      headers,
      body: bodyBytes ?? undefined,
    });
    const accessContext = options.accessContext?.();
    requestContexts.set(request, {
      authorized: options.isAuthorized(),
      inProcess: isAuthenticatedInProcessRequest(req),
      trustedLocal: options.isTrustedLocal?.() === true,
      ...(accessContext
        ? { accessContext: structuredClone(accessContext) }
        : {}),
    });
    const response: Response = await app.fetch(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    if (!response.body) {
      res.end();
      return true;
    }
    // Stream the body through the Node response.
    await pipeWebBodyToNodeResponse(
      response.body,
      res,
      controller.signal,
      runtime,
    );
    return true;
  } catch (error) {
    // error-policy:J1 A partial response cannot become a successful end-of-stream.
    if (!controller.signal.aborted) {
      if (!res.headersSent) throw error;
      const failure = new ElizaError("Plugin response stream failed", {
        code: "PLUGIN_ROUTE_STREAM_FAILED",
        cause: error,
        context: { method, pathname },
      });
      runtime.reportError("http.pluginStream", failure);
      res.destroy(failure);
    }
    return true;
  } finally {
    req.off("aborted", abort);
    res.off("close", disconnected);
  }
}
