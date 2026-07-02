/**
 * HTTP routes the Birdclaw view (and any other client) drives.
 *
 * All routes are private (no `public: true`), so the agent server's standard
 * route authorization applies before a handler runs — these expose the
 * owner's archived tweets, mentions, and DMs. `rawPath` keeps the URLs stable
 * at `/api/birdclaw/*` for the view instead of prefixing the plugin name.
 *
 * Error contract the view renders from:
 *  - 200 `{ status }` from GET /status even when birdclaw is missing
 *    (`installed: false` + a resolution message → setup screen).
 *  - 503 `{ error, installed: false }` from data routes when the CLI is
 *    missing or the service is not registered.
 *  - 400 `{ error }` for invalid parameters.
 *  - 502 `{ error }` when the CLI itself fails (broken DB, sync failure).
 */

import type {
  Route,
  RouteHandlerContext,
  RouteHandlerResult,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { BirdclawCliError } from "../birdclaw/cli.ts";
import { BirdclawService, clampLimit } from "../birdclaw/service.ts";
import {
  isBirdclawDigestPeriod,
  isBirdclawInboxKind,
  isBirdclawResource,
  isBirdclawSyncCollection,
} from "../types.ts";

function json(status: number, body: unknown): RouteHandlerResult {
  return { status, headers: { "content-type": "application/json" }, body };
}

function getService(ctx: RouteHandlerContext): BirdclawService | null {
  return (
    (ctx.runtime.getService(
      BirdclawService.serviceType,
    ) as BirdclawService | null) ?? null
  );
}

function queryStr(ctx: RouteHandlerContext, name: string): string | undefined {
  const value = ctx.query[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim().length > 0
    ? first.trim()
    : undefined;
}

function queryFlag(ctx: RouteHandlerContext, name: string): boolean {
  const value = queryStr(ctx, name);
  return value === "1" || value === "true";
}

function queryLimit(ctx: RouteHandlerContext, fallback: number): number {
  const raw = queryStr(ctx, "limit");
  return clampLimit(raw === undefined ? undefined : Number(raw), fallback);
}

/** Map a thrown CLI error to the route error contract. */
function cliFailure(err: unknown): RouteHandlerResult {
  if (err instanceof BirdclawCliError) {
    if (err.kind === "not-installed") {
      return json(503, { error: err.message, installed: false });
    }
    return json(502, { error: err.message });
  }
  const message = err instanceof Error ? err.message : String(err);
  return json(502, { error: message });
}

async function statusHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const svc = getService(ctx);
  if (!svc) {
    return json(200, {
      status: {
        installed: false,
        version: null,
        home: null,
        counts: null,
        transport: null,
        message: "BIRDCLAW_SERVICE is not available on this agent.",
      },
    });
  }
  return json(200, { status: await svc.status() });
}

async function tweetsHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const svc = getService(ctx);
  if (!svc) {
    return json(503, {
      error: "BIRDCLAW_SERVICE is not available.",
      installed: false,
    });
  }
  const resource = queryStr(ctx, "resource") ?? "home";
  if (!isBirdclawResource(resource)) {
    return json(400, {
      error: `Unsupported resource "${resource}". Expected home, mentions, or authored.`,
    });
  }
  try {
    const tweets = await svc.searchTweets({
      query: queryStr(ctx, "q"),
      resource,
      liked: queryFlag(ctx, "liked"),
      bookmarked: queryFlag(ctx, "bookmarked"),
      limit: queryLimit(ctx, 20),
    });
    return json(200, { tweets });
  } catch (err) {
    return cliFailure(err);
  }
}

async function inboxHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const svc = getService(ctx);
  if (!svc) {
    return json(503, {
      error: "BIRDCLAW_SERVICE is not available.",
      installed: false,
    });
  }
  const kind = queryStr(ctx, "kind") ?? "mixed";
  if (!isBirdclawInboxKind(kind)) {
    return json(400, {
      error: `Unsupported inbox kind "${kind}". Expected mixed, mentions, or dms.`,
    });
  }
  try {
    const items = await svc.inbox({ kind, limit: queryLimit(ctx, 20) });
    return json(200, { items });
  } catch (err) {
    return cliFailure(err);
  }
}

async function syncHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const svc = getService(ctx);
  if (!svc) {
    return json(503, {
      error: "BIRDCLAW_SERVICE is not available.",
      installed: false,
    });
  }
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const collection = typeof body.collection === "string" ? body.collection : "";
  if (!isBirdclawSyncCollection(collection)) {
    return json(400, {
      error: `Unsupported sync collection "${collection}". Expected timeline, mentions, authored, likes, or bookmarks.`,
    });
  }
  try {
    const result = await svc.sync(collection);
    logger.info(`[plugin-birdclaw] sync ${collection}: ${result.summary}`);
    return json(200, { result });
  } catch (err) {
    return cliFailure(err);
  }
}

async function digestHandler(
  ctx: RouteHandlerContext,
): Promise<RouteHandlerResult> {
  const svc = getService(ctx);
  if (!svc) {
    return json(503, {
      error: "BIRDCLAW_SERVICE is not available.",
      installed: false,
    });
  }
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const period = typeof body.period === "string" ? body.period : "today";
  if (!isBirdclawDigestPeriod(period)) {
    return json(400, {
      error: `Unsupported digest period "${period}". Expected today, 24h, yesterday, or week.`,
    });
  }
  try {
    const digest = await svc.digest(period);
    return json(200, { digest });
  } catch (err) {
    return cliFailure(err);
  }
}

export const birdclawRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/birdclaw/status",
    rawPath: true,
    name: "birdclaw-status",
    routeHandler: statusHandler,
  },
  {
    type: "GET",
    path: "/api/birdclaw/tweets",
    rawPath: true,
    name: "birdclaw-tweets",
    routeHandler: tweetsHandler,
  },
  {
    type: "GET",
    path: "/api/birdclaw/inbox",
    rawPath: true,
    name: "birdclaw-inbox",
    routeHandler: inboxHandler,
  },
  {
    type: "POST",
    path: "/api/birdclaw/sync",
    rawPath: true,
    name: "birdclaw-sync",
    routeHandler: syncHandler,
  },
  {
    type: "POST",
    path: "/api/birdclaw/digest",
    rawPath: true,
    name: "birdclaw-digest",
    routeHandler: digestHandler,
  },
];
