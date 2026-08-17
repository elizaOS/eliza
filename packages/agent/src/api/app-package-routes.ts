/**
 * Dispatches dynamic `/api/apps/<slug>/...` requests to the route module that
 * ships with each installed app package. Reserved top-level slugs (info,
 * installed, launch, …) are excluded so they fall through to their own
 * handlers; for any other slug it lazy-imports the app's route module, resolves
 * either its `handleAppRoutes` export or a legacy `handleApps<Slug>Routes`
 * name, and calls it with a `readJsonBody` pre-bound to the current request.
 */
import type {
  AppPackageRouteContext,
  AppPackageRouteDispatchContext,
} from "@elizaos/core";
import {
  type AppRouteModule,
  importAppRouteModule,
} from "../services/app-package-modules.ts";
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

function toLegacyHandlerName(slug: string): string {
  const normalized = slug
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `handleApps${normalized}Routes`;
}

function resolveAppRouteHandler(
  routeModule: AppRouteModule,
  slug: string,
): ((ctx: AppPackageRouteContext) => Promise<boolean>) | null {
  if (typeof routeModule.handleAppRoutes === "function") {
    return routeModule.handleAppRoutes;
  }

  const legacyHandler = routeModule[toLegacyHandlerName(slug)];
  if (typeof legacyHandler === "function") {
    return legacyHandler as (ctx: AppPackageRouteContext) => Promise<boolean>;
  }

  return null;
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

  const slug = decodedSlug.trim();
  if (!slug || RESERVED_APP_ROUTE_SLUGS.has(slug)) return false;

  const routeModule = await importAppRouteModule(slug);
  if (!routeModule) return false;

  const handler = resolveAppRouteHandler(routeModule, slug);
  if (!handler) return false;

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
