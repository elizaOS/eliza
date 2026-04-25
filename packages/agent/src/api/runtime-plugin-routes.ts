/**
 * Dispatches elizaOS AgentRuntime plugin routes (runtime.routes) on the Eliza
 * raw Node HTTP server. Core registers paths like `/music-player/stream`; without
 * this bridge those handlers never run.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRuntime, PaymentEnabledRoute, Route } from "@elizaos/core";
import {
  createPaymentAwareHandler,
  isRoutePaymentWrapped,
} from "../middleware/x402/payment-wrapper.ts";

const EXPRESS_SHIM = Symbol("elizaExpressResponseShim");

export function matchPluginRoutePath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const norm = (p: string) => p.split("/").filter((s) => s.length > 0);
  const pSegs = norm(pattern);
  const pathSegs = norm(pathname);
  if (pSegs.length !== pathSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i];
    const c = pathSegs[i];
    if (!p || c === undefined) return null;
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
  return params;
}

function searchParamsToQuery(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const vals = url.searchParams.getAll(key);
    out[key] = vals.length <= 1 ? (vals[0] ?? "") : vals;
  }
  return out;
}

function attachExpressResponseHelpers(res: ServerResponse): void {
  const marked = res as ServerResponse & { [EXPRESS_SHIM]?: boolean };
  if (marked[EXPRESS_SHIM]) return;
  marked[EXPRESS_SHIM] = true;

  const r = res as ServerResponse & {
    status: (code: number) => {
      json: (data: unknown) => void;
      send: (data: unknown) => void;
    };
  };

  r.status = (code: number) => {
    res.statusCode = code;
    return {
      json(data: unknown) {
        if (res.headersSent) return;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(data));
      },
      send(data: unknown) {
        if (res.headersSent) return;
        if (typeof data === "string" || Buffer.isBuffer(data)) {
          res.end(data);
        } else {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(data));
        }
      },
    };
  };
}

function augmentRequest(
  req: IncomingMessage,
  url: URL,
  params: Record<string, string>,
): IncomingMessage {
  const query = searchParamsToQuery(url);
  const protoHeader = req.headers["x-forwarded-proto"];
  const proto =
    typeof protoHeader === "string"
      ? protoHeader.split(",")[0]?.trim() || "http"
      : "http";

  const base = req as IncomingMessage & {
    query?: Record<string, string | string[]>;
    params?: Record<string, string>;
    protocol?: string;
    path?: string;
    method?: string;
    get?: (name: string) => string | undefined;
  };
  base.query = query;
  base.params = params;
  base.protocol = proto;
  base.path = url.pathname;
  base.method = req.method ?? "GET";
  base.get = (name: string) => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  return req;
}

/**
 * Runs the first matching runtime plugin route. Returns true if matched (even on handler error).
 */
export async function tryHandleRuntimePluginRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  runtime: AgentRuntime | null | undefined;
  isAuthorized: () => boolean;
}): Promise<boolean> {
  const { req, res, method, pathname, url, runtime, isAuthorized } = options;
  if (!runtime?.routes?.length) return false;

  for (const route of runtime.routes as Route[]) {
    if (route.type === "STATIC") continue;
    if (route.type !== method) continue;
    const handler = route.handler;
    if (!handler) continue;

    const params = matchPluginRoutePath(route.path, pathname);
    if (params === null) continue;

    if (route.public !== true && !isAuthorized()) {
      if (!res.headersSent) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Unauthorized" }));
      }
      return true;
    }

    attachExpressResponseHelpers(res);
    augmentRequest(req, url, params);

    const effectiveHandler =
      route.x402 != null && !isRoutePaymentWrapped(route)
        ? createPaymentAwareHandler(route as PaymentEnabledRoute)
        : handler;

    try {
      await effectiveHandler(req as never, res as never, runtime);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : "Internal server error",
          }),
        );
      }
      return true;
    }

    // Do not auto-end: handlers may return after attaching long-lived streams
    // (e.g. music-player) before headers or first bytes are flushed.
    return true;
  }

  return false;
}
