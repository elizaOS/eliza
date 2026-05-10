/**
 * GET /api/build/variant
 *
 * Tiny endpoint that exposes the desktop build variant + platform so the
 * renderer can drive variant-conditional UI (e.g. greying out "Local" in
 * sandboxed store builds).
 *
 * Reads MILADY_BUILD_VARIANT directly here rather than going through the
 * dynamic @elizaos/app-core import — the API server boots before the agent
 * runtime, so the canonical accessor module isn't loaded yet, but the env
 * var is set by the desktop-build orchestrator.
 */

import type http from "node:http";

export type BuildVariant = "store" | "direct";

export interface BuildVariantResponse {
  variant: BuildVariant;
  platform: NodeJS.Platform;
}

function resolveBuildVariant(): BuildVariant {
  return process.env.MILADY_BUILD_VARIANT === "store" ? "store" : "direct";
}

export interface BuildVariantRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
}

export function handleBuildVariantRoutes(
  ctx: BuildVariantRouteContext,
): boolean {
  const { res, method, pathname, json } = ctx;

  if (method === "GET" && pathname === "/api/build/variant") {
    const payload: BuildVariantResponse = {
      variant: resolveBuildVariant(),
      platform: process.platform,
    };
    json(res, payload);
    return true;
  }

  return false;
}
