/**
 * Dispatches dynamic `/api/apps/<slug>/...` requests to the route module that
 * ships with each installed app package. Reserved top-level slugs (info,
 * installed, launch, …) are excluded so they fall through to their own
 * handlers; for any other slug it lazy-imports the app's route module, resolves
 * its `handleAppRoutes` export, and calls it with a `readJsonBody` pre-bound to the current request.
 */

import { isValidAppRouteSlug } from "@elizaos/core";
import type {
  AppPackageRouteContext,
  AppPackageRouteDispatchContext,
} from "@elizaos/host/protocol";

import { importAppRouteModule } from "../services/app-package-modules.ts";
import { decodePathComponent } from "./server-helpers.ts";

const RESERVED_APP_ROUTE_SLUGS = new Set([
  "",
  "info",
  "installed",
  "launch",
  "plugins",
  "refresh",
  "runs",
  "search",
  "stop",
]);

function extractEncodedAppSlug(pathname: string): string | null {
  const match = pathname.match(/^\/api\/apps\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

export async function handleAppPackageRoutes(
  ctx: AppPackageRouteDispatchContext,
): Promise<boolean> {
  const encodedSlug = extractEncodedAppSlug(ctx.pathname);
  if (encodedSlug === null) return false;

  // error-policy:J3 untrusted-input sanitizing — the shared HTTP boundary
  // decoder writes the explicit 400 response for malformed percent encoding.
  const decodedSlug = decodePathComponent(encodedSlug, ctx.res, "app slug");
  if (decodedSlug === null) return true;

  const slug = decodedSlug;
  if (RESERVED_APP_ROUTE_SLUGS.has(slug)) return false;
  if (!isValidAppRouteSlug(slug)) {
    ctx.error(ctx.res, "Invalid app slug", 400);
    return true;
  }

  const routeModule = await importAppRouteModule(slug);
  if (!routeModule) return false;

  const handler = routeModule.handleAppRoutes;
  if (typeof handler !== "function") return false;

  // App route handlers expect readJsonBody pre-bound to the current request,
  // but the server-level helper requires (req, res) arguments.  Wrap it so
  // handlers can call readJsonBody() with no arguments.
  const boundCtx: AppPackageRouteContext = {
    ...ctx,
    readJsonBody: ((options) =>
      ctx.readJsonBody(
        ctx.req,
        ctx.res,
        options,
      )) as AppPackageRouteContext["readJsonBody"],
  };

  return handler(boundCtx);
}
