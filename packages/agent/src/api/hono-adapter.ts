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
  AccessContext,
  IAgentRuntime,
  Route,
  RouteHandlerResult,
} from "@elizaos/core";
import { type Context, Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { dispatchRoute } from "./dispatch-route.ts";

export interface HonoAdapterOptions {
  /** Predicate that decides whether the incoming request has a valid token. */
  isAuthorized: (req: Request) => boolean;
  /** Predicate that decides whether the incoming request is trusted loopback/local. */
  isTrustedLocal?: (req: Request) => boolean;
  /**
   * Boundary-resolved requester identity for per-viewer DTO selection
   * (#14781). Absent/`undefined` means the single-owner local boundary and
   * routes serve their existing unfiltered content.
   */
  resolveAccessContext?: (req: Request) => AccessContext | undefined;
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
): Promise<{ body: unknown; rawBody?: string }> {
  if (method === "GET" || method === "HEAD") {
    return { body: undefined };
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await request.text();
    if (!text.trim()) {
      return { body: undefined, rawBody: text };
    }
    try {
      return { body: JSON.parse(text), rawBody: text };
    } catch {
      return { body: text, rawBody: text };
    }
  }
  const text = await request.text();
  return { body: text, rawBody: text };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function searchParamsToQuery(url: URL): Record<string, string | string[]> {
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
  const routes = runtime.routes;
  for (const route of routes as Route[]) {
    if (!honoMethod(route.type)) continue;
    if (!route.handler && !route.routeHandler) continue;

    const honoPath = toHonoPath(route.path);

    const honoHandler = async (ctx: Context): Promise<Response> => {
      const request = ctx.req.raw;
      const url = new URL(request.url);
      const params = ctx.req.param();
      const { body, rawBody } = await readBodyForDispatch(
        request,
        request.method,
      );
      const result: RouteHandlerResult | null = await dispatchRoute({
        runtime,
        method: request.method,
        path: url.pathname,
        headers: headersToRecord(request.headers),
        query: searchParamsToQuery(url),
        body,
        rawBody,
        inProcess: false,
        isAuthorized: () => options.isAuthorized(request),
        isTrustedLocal: () => options.isTrustedLocal?.(request) ?? false,
        accessContext: options.resolveAccessContext?.(request),
      }).catch(
        (err: unknown): RouteHandlerResult => ({
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: {
            error: err instanceof Error ? err.message : "Internal server error",
          },
        }),
      );

      if (result === null) {
        // Should be unreachable — Hono only invokes this handler on a match.
        void params;
        return new Response("Not Found", { status: 404 });
      }

      const headers = new Headers(result.headers ?? {});
      if (result.stream) {
        const resultStream = result.stream;
        // Carry the handler's status and headers onto the streamed response —
        // honoStream builds the Response from the context, so without this an
        // SSE route loses its `content-type: text/event-stream` (breaking
        // EventSource clients) and any non-200 status collapses to 200.
        ctx.status(result.status as ContentfulStatusCode);
        headers.forEach((value, key) => {
          ctx.header(key, value);
        });
        return honoStream(ctx, async (stream) => {
          for await (const chunk of resultStream) {
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
        bodyOut = new Uint8Array(result.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/octet-stream");
        }
      } else {
        bodyOut = JSON.stringify(result.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json; charset=utf-8");
        }
      }
      return new Response(bodyOut, { status: result.status, headers });
    };

    switch (route.type) {
      case "GET":
        app.get(honoPath, honoHandler);
        break;
      case "POST":
        app.post(honoPath, honoHandler);
        break;
      case "PUT":
        app.put(honoPath, honoHandler);
        break;
      case "PATCH":
        app.patch(honoPath, honoHandler);
        break;
      case "DELETE":
        app.delete(honoPath, honoHandler);
        break;
    }
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
