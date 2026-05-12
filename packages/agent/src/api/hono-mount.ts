/**
 * Bridge between Node's `http.IncomingMessage` / `ServerResponse` and a Hono
 * app. Lets the existing raw-Node server hand requests off to Hono for the
 * subset of routes that go through `runtime.routes`.
 */

import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { IAgentRuntime, Route } from "@elizaos/core";
import type { Hono } from "hono";

import { buildHonoAppForRuntime } from "./hono-adapter.ts";
import { matchPluginRoutePath } from "./runtime-plugin-routes.ts";

interface RuntimeHonoCache {
  runtime: WeakRef<IAgentRuntime>;
  app: Hono;
}

let cached: RuntimeHonoCache | null = null;

function getHonoApp(
  runtime: IAgentRuntime,
  isAuthorized: (req: Request) => boolean,
): Hono {
  if (cached && cached.runtime.deref() === runtime) {
    return cached.app;
  }
  const app = buildHonoAppForRuntime(runtime, { isAuthorized });
  cached = { runtime: new WeakRef(runtime), app };
  return app;
}

/** Reset the cached Hono app — call when `runtime.routes` changes. */
export function resetHonoMountCache(): void {
  cached = null;
}

async function readNodeBody(req: IncomingMessage): Promise<Uint8Array | null> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  return new Uint8Array(Buffer.concat(chunks));
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

/**
 * Try to dispatch a request through the runtime-routes Hono app. Returns
 * `true` if Hono produced a response (including 404 from Hono itself for any
 * registered method-mismatch case), `false` if no route matched.
 */
/**
 * Returns true when the runtime has a route registered for this method+path
 * that has a `routeHandler` (the new return-shape contract). The legacy
 * Express-shaped `handler` field is already covered by
 * `tryHandleRuntimePluginRoute`, so we let that path own it for the duration
 * of the migration.
 */
function hasHonoEligibleRoute(
  runtime: IAgentRuntime,
  method: string,
  pathname: string,
): boolean {
  const upper = method.toUpperCase();
  for (const route of runtime.routes as Route[]) {
    if (route.type === "STATIC") continue;
    if (route.type !== upper) continue;
    if (!route.routeHandler) continue;
    if (matchPluginRoutePath(route.path, pathname) === null) continue;
    return true;
  }
  return false;
}

export async function tryHandleHonoRuntimeRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  runtime: IAgentRuntime | null | undefined;
  isAuthorized: () => boolean;
}): Promise<boolean> {
  const { req, res, runtime } = options;
  if (!runtime?.routes?.length) return false;

  const method = req.method ?? "GET";
  const requestUrl = req.url ?? "/";
  const pathname = (() => {
    try {
      return new URL(requestUrl, `http://${req.headers.host ?? "localhost"}`)
        .pathname;
    } catch {
      return requestUrl.split("?")[0] ?? "/";
    }
  })();

  if (!hasHonoEligibleRoute(runtime, method, pathname)) {
    return false;
  }

  const app = getHonoApp(runtime, () => options.isAuthorized());

  const bodyBytes = await readNodeBody(req);
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );

  // Hono needs a Web Request. Avoid leaking the body to GET/HEAD.
  const request = new Request(url, {
    method: req.method ?? "GET",
    headers: nodeHeadersToWeb(req.headers),
    body: (bodyBytes ?? undefined) as unknown as BodyInit | undefined,
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
  const nodeStream = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
  );
  nodeStream.on("error", () => {
    if (!res.writableEnded) res.end();
  });
  nodeStream.pipe(res);
  return true;
}
