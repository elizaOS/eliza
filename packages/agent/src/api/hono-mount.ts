/**
 * Bridge between Node's `http.IncomingMessage` / `ServerResponse` and a Hono
 * app. Lets the existing raw-Node server hand requests off to Hono for the
 * subset of routes that go through `runtime.routes`.
 */

import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AccessContext, IAgentRuntime, Route, UUID } from "@elizaos/core";
import type { Hono } from "hono";

import { buildHonoAppForRuntime } from "./hono-adapter.ts";
import { matchPluginRoutePath } from "./runtime-plugin-routes.ts";

interface RuntimeHonoCache {
  runtime: WeakRef<IAgentRuntime>;
  app: Hono;
}

let cached: RuntimeHonoCache | null = null;
const INTERNAL_AUTHORIZED_HEADER = "x-eliza-internal-authorized";
const INTERNAL_TRUSTED_LOCAL_HEADER = "x-eliza-internal-trusted-local";
// Carries the boundary-resolved AccessContext (JSON) from the Node listener
// into the Hono app (#14781). Like the two headers above it is INTERNAL-ONLY:
// tryHandleHonoRuntimeRoute always overwrites/deletes it before dispatch, so a
// client-supplied value can never smuggle a principal in.
const INTERNAL_ACCESS_CONTEXT_HEADER = "x-eliza-internal-access-context";

const ROLE_NAMES = new Set(["OWNER", "ADMIN", "USER", "GUEST"]);

/**
 * Parse the internal access-context header back into a typed AccessContext.
 * The value is producer-controlled (set by this module's own caller), but the
 * parse still validates every field so a malformed value yields NO principal
 * rather than a corrupt one.
 */
// error-policy:J3 untrusted-input sanitizing — a malformed header resolves to
// undefined (no principal / owner-boundary semantics are NOT granted: routes
// only widen disclosure when a context is absent because the caller was
// trunk-authorized, and that path never sets this header).
function parseInternalAccessContext(
  value: string | null,
): AccessContext | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.requesterEntityId !== "string" ||
      record.requesterEntityId.length === 0
    ) {
      return undefined;
    }
    const role =
      typeof record.role === "string" && ROLE_NAMES.has(record.role)
        ? (record.role as AccessContext["role"])
        : undefined;
    return {
      requesterEntityId: record.requesterEntityId as UUID,
      ...(typeof record.worldId === "string"
        ? { worldId: record.worldId as UUID }
        : {}),
      ...(role ? { role } : {}),
      ...(typeof record.isOwner === "boolean"
        ? { isOwner: record.isOwner }
        : {}),
      ...(typeof record.source === "string" ? { source: record.source } : {}),
    };
  } catch {
    // error-policy:J3 untrusted-input sanitizing — a malformed header yields no
    // principal (undefined), never a fabricated identity.
    return undefined;
  }
}

function getHonoApp(runtime: IAgentRuntime): Hono {
  if (cached && cached.runtime.deref() === runtime) {
    return cached.app;
  }
  const app = buildHonoAppForRuntime(runtime, {
    isAuthorized: (req) => req.headers.get(INTERNAL_AUTHORIZED_HEADER) === "1",
    isTrustedLocal: (req) =>
      req.headers.get(INTERNAL_TRUSTED_LOCAL_HEADER) === "1",
    resolveAccessContext: (req) =>
      parseInternalAccessContext(
        req.headers.get(INTERNAL_ACCESS_CONTEXT_HEADER),
      ),
  });
  cached = { runtime: new WeakRef(runtime), app };
  return app;
}

/** Reset the cached Hono app — call when `runtime.routes` changes. */
export function resetHonoMountCache(): void {
  cached = null;
}

async function readNodeBody(req: IncomingMessage): Promise<ArrayBuffer | null> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const concatenated = Buffer.concat(chunks);
  const body = new ArrayBuffer(concatenated.byteLength);
  new Uint8Array(body).set(concatenated);
  return body;
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
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          function cleanup() {
            res.off("drain", onDrain);
            res.off("error", onError);
          }
          function onDrain() {
            cleanup();
            resolve();
          }
          function onError(error: Error) {
            cleanup();
            reject(error);
          }
          res.once("drain", onDrain);
          res.once("error", onError);
        });
      }
    }
  } catch {
    if (!res.writableEnded) res.end();
  } finally {
    reader.releaseLock();
  }
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
  isTrustedLocal?: () => boolean;
  /** Boundary-resolved requester identity for per-viewer DTO selection (#14781). */
  accessContext?: () => AccessContext | undefined;
}): Promise<boolean> {
  const { req, res, runtime } = options;
  if (!runtime?.routes?.length) return false;

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

  if (!hasHonoEligibleRoute(runtime, method, pathname)) {
    return false;
  }

  const app = getHonoApp(runtime);

  const bodyBytes = await readNodeBody(req);
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  // Hand Hono the normalized path so its strict router agrees with the
  // tolerant eligibility gate above (and with dispatchRoute inside the
  // handler, which re-matches against the same normalized path).
  url.pathname = pathname;
  const headers = nodeHeadersToWeb(req.headers);
  headers.set(INTERNAL_AUTHORIZED_HEADER, options.isAuthorized() ? "1" : "0");
  headers.set(
    INTERNAL_TRUSTED_LOCAL_HEADER,
    options.isTrustedLocal?.() ? "1" : "0",
  );
  // Always overwrite (or drop) the internal access-context header so an
  // inbound client value can never survive into dispatch.
  const accessContext = options.accessContext?.();
  if (accessContext) {
    headers.set(INTERNAL_ACCESS_CONTEXT_HEADER, JSON.stringify(accessContext));
  } else {
    headers.delete(INTERNAL_ACCESS_CONTEXT_HEADER);
  }

  // Hono needs a Web Request. Avoid leaking the body to GET/HEAD.
  const request = new Request(url, {
    method: req.method ?? "GET",
    headers,
    body: bodyBytes ?? undefined,
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
  void pipeWebBodyToNodeResponse(response.body, res);
  return true;
}
