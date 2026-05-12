/**
 * Hono adapter for plugin routes.
 *
 * Registers every entry in `runtime.routes` onto a Hono app, marshals the
 * incoming Hono `Context` into a `RouteHandlerContext`, calls the canonical
 * `dispatchRoute` (with `inProcess: false`), and writes the result back to
 * Hono.
 *
 * This lives in front of the existing hardcoded Node HTTP handlers — it
 * covers any plugin route registered via `runtime.routes`. The hardcoded
 * handlers will be migrated onto `runtime.routes` in later phases.
 */

import type {
  IAgentRuntime,
  Route,
  RouteHandlerResult,
} from "@elizaos/core";
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";

import { dispatchRoute } from "./dispatch-route.ts";

export interface HonoAdapterOptions {
  /** Predicate that decides whether the incoming request has a valid token. */
  isAuthorized: (req: Request) => boolean;
}

function honoMethod(type: Route["type"]): string | null {
  switch (type) {
    case "GET":
      return "get";
    case "POST":
      return "post";
    case "PUT":
      return "put";
    case "PATCH":
      return "patch";
    case "DELETE":
      return "delete";
    default:
      return null;
  }
}

/**
 * Translate an elizaOS route path (which uses `:param` and `:rest*` tokens)
 * to Hono's path syntax. Hono supports `:param` directly; trailing `*` becomes
 * `:param{.+}` in Hono.
 */
function toHonoPath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":") && seg.endsWith("*")) {
        const name = seg.slice(1, -1);
        return `:${name}{.+}`;
      }
      return seg;
    })
    .join("/");
}

async function readBodyForDispatch(
  request: Request,
  method: string,
): Promise<unknown> {
  if (method === "GET" || method === "HEAD") return undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await request.text();
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return await request.text();
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function searchParamsToQuery(
  url: URL,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length <= 1 ? (all[0] ?? "") : all;
  }
  return out;
}

/**
 * Mount every `runtime.routes` entry onto the given Hono app.
 *
 * Each registered handler runs the canonical {@link dispatchRoute}; that means
 * the Hono surface and the in-process IPC surface execute the exact same code
 * path against the same route table.
 */
export function mountRoutesOnHono(
  app: Hono,
  runtime: IAgentRuntime,
  options: HonoAdapterOptions,
): void {
  const routes = runtime.routes ?? [];
  for (const route of routes as Route[]) {
    const method = honoMethod(route.type);
    if (!method) continue;
    if (!route.handler && !route.routeHandler) continue;

    const honoPath = toHonoPath(route.path);

    // Hono's app[method] signature is uniform across verbs.
    (app as unknown as Record<string, (path: string, handler: (c: unknown) => unknown) => void>)
      [method](honoPath, async (c: unknown) => {
        const ctx = c as {
          req: { raw: Request; param: () => Record<string, string> };
          newResponse: (
            body: BodyInit | null,
            init?: ResponseInit,
          ) => Response;
        };
        const request = ctx.req.raw;
        const url = new URL(request.url);
        const params = ctx.req.param();
        const body = await readBodyForDispatch(request, request.method);
        const result: RouteHandlerResult | null = await dispatchRoute({
          runtime,
          method: request.method,
          path: url.pathname,
          headers: headersToRecord(request.headers),
          query: searchParamsToQuery(url),
          body,
          inProcess: false,
          isAuthorized: () => options.isAuthorized(request),
        }).catch((err: unknown): RouteHandlerResult => ({
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: {
            error: err instanceof Error ? err.message : "Internal server error",
          },
        }));

        if (result === null) {
          // Should be unreachable — Hono only invokes this handler on a match.
          void params;
          return ctx.newResponse("Not Found", { status: 404 });
        }

        const headers = new Headers(result.headers ?? {});
        if (result.stream) {
          return (
            honoStream as unknown as (
              c: unknown,
              cb: (stream: {
                write: (chunk: string | Uint8Array) => Promise<void>;
                close: () => Promise<void>;
              }) => Promise<void>,
            ) => Response
          )(ctx, async (stream) => {
            for await (const chunk of result.stream!) {
              await stream.write(chunk);
            }
            await stream.close();
          });
        }

        let bodyOut: BodyInit | null = null;
        if (result.body == null) {
          bodyOut = null;
        } else if (typeof result.body === "string") {
          bodyOut = result.body;
          if (!headers.has("content-type")) {
            headers.set("content-type", "text/plain; charset=utf-8");
          }
        } else if (result.body instanceof Uint8Array) {
          bodyOut = result.body as unknown as BodyInit;
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/octet-stream");
          }
        } else {
          bodyOut = JSON.stringify(result.body);
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json; charset=utf-8");
          }
        }
        return ctx.newResponse(bodyOut, { status: result.status, headers });
      });
  }
}

/** Convenience: build a new Hono app already wired to the runtime. */
export function buildHonoAppForRuntime(
  runtime: IAgentRuntime,
  options: HonoAdapterOptions,
): Hono {
  const app = new Hono();
  mountRoutesOnHono(app, runtime, options);
  return app;
}
