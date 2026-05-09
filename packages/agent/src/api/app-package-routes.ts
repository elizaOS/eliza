import type { RouteHelpers, RouteRequestMeta } from "@elizaos/shared";
import {
  type AppRouteModule,
  importAppRouteModule,
} from "../services/app-package-modules.js";

export interface AppPackageRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "error" | "json" | "readJsonBody"> {
  url: URL;
  runtime: unknown | null;
}

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

function extractAppSlug(pathname: string): string | null {
  const match = pathname.match(/^\/api\/apps\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return null;
  const slug = decodeURIComponent(match[1]).trim();
  if (!slug || RESERVED_APP_ROUTE_SLUGS.has(slug)) {
    return null;
  }
  return slug;
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
  ctx: AppPackageRouteContext,
): Promise<boolean> {
  const slug = extractAppSlug(ctx.pathname);
  if (!slug) return false;

  const routeModule = await importAppRouteModule(slug);
  if (!routeModule) return false;

  const handler = resolveAppRouteHandler(routeModule, slug);
  if (!handler) return false;

  // App route handlers expect readJsonBody pre-bound to the current request,
  // but the server-level helper requires (req, res) arguments.  Wrap it so
  // handlers can call readJsonBody() with no arguments.
  const boundCtx: AppPackageRouteContext = {
    ...ctx,
    readJsonBody: (() =>
      ctx.readJsonBody(ctx.req, ctx.res)) as typeof ctx.readJsonBody,
  };

  return handler(boundCtx);
}
