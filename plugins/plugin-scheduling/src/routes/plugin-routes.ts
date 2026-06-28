/**
 * Core `routes:` adapter for the generic scheduled-tasks REST surface.
 *
 * Wraps {@link makeScheduledTasksRouteHandler} in elizaOS `LegacyRouteHandler`s
 * (one per path in {@link SCHEDULED_TASKS_ROUTE_PATHS}) and resolves the runner
 * via the runtime-hosted {@link getScheduledTaskRunner}. Because the route is
 * registered on the always-loaded scheduling plugin, the API is served on every
 * platform — including mobile — with the path unchanged (`rawPath: true` keeps
 * the `/api/lifeops/...` prefix exactly).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime, LegacyRouteHandler, Route } from "@elizaos/core";
import {
  readJsonBody as httpReadJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/shared";
import { getScheduledTaskRunner } from "../scheduled-task/runner-service.js";
import {
  makeScheduledTasksRouteHandler,
  SCHEDULED_TASKS_ROUTE_PATHS,
  type SchedulingRouteContext,
} from "./scheduled-tasks.js";

function requestBaseUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return `${proto}://${host}`;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isIncomingMessage(value: unknown): value is IncomingMessage {
  return isRecord(value) && isRecord(value.headers) && isRecord(value.socket);
}

function isServerResponse(value: unknown): value is ServerResponse {
  return (
    isRecord(value) &&
    typeof value.end === "function" &&
    typeof value.setHeader === "function"
  );
}

function buildContext(
  req: IncomingMessage,
  res: ServerResponse,
): SchedulingRouteContext {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", requestBaseUrl(req));
  return {
    req,
    res,
    method,
    pathname: url.pathname,
    url,
    json: sendJson,
    error: sendJsonError,
    readJsonBody: <T extends object>(r: IncomingMessage, s: ServerResponse) =>
      httpReadJsonBody<T>(r, s),
  };
}

function scheduledTasksLegacyHandler(): LegacyRouteHandler {
  const runtimeByContext = new WeakMap<SchedulingRouteContext, IAgentRuntime>();
  const handle = makeScheduledTasksRouteHandler({
    async resolveRunner(ctx) {
      const runtime = runtimeByContext.get(ctx);
      if (!runtime) {
        ctx.error(ctx.res, "Agent runtime is not available", 503);
        return null;
      }
      return getScheduledTaskRunner(runtime, { agentId: runtime.agentId });
    },
  });
  return async (req, res, runtime): Promise<void> => {
    if (!isIncomingMessage(req) || !isServerResponse(res)) {
      throw new TypeError(
        "Scheduled-tasks legacy route requires Node HTTP request/response objects",
      );
    }

    const ctx = buildContext(req, res);
    runtimeByContext.set(ctx, runtime);
    const handled = await handle(ctx);
    if (!handled) {
      sendJsonError(res, "Scheduled-tasks route not found", 404);
    }
  };
}

/**
 * The `routes:` entries for the scheduling plugin. One shared handler matches
 * every scheduled-task path; each route entry points at it so the runtime's
 * router dispatches the full surface to the single matcher.
 */
export function buildSchedulingRoutes(): Route[] {
  const handler = scheduledTasksLegacyHandler();
  return SCHEDULED_TASKS_ROUTE_PATHS.map((spec) => ({
    type: spec.type,
    path: spec.path,
    rawPath: true,
    handler,
  }));
}
