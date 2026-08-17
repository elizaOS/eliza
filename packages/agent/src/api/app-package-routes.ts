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

type AppSlugParseResult =
  | { kind: "unmatched" }
  | { kind: "invalid" }
  | { kind: "slug"; value: string };

function parseAppSlug(pathname: string): AppSlugParseResult {
  const match = pathname.match(/^\/api\/apps\/([^/]+)(?:\/|$)/);
  if (!match?.[1]) return { kind: "unmatched" };

  let slug: string;
  try {
    slug = decodeURIComponent(match[1]).trim();
  } catch {
    // error-policy:J3 untrusted-input sanitizing — malformed path encoding is
    // reported by the route boundary instead of escaping as URIError.
    return { kind: "invalid" };
  }

  if (!slug || RESERVED_APP_ROUTE_SLUGS.has(slug)) {
    return { kind: "unmatched" };
  }
  return { kind: "slug", value: slug };
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
  const parsedSlug = parseAppSlug(ctx.pathname);
  if (parsedSlug.kind === "unmatched") return false;
  if (parsedSlug.kind === "invalid") {
    ctx.error(ctx.res, "Invalid app slug: malformed URL encoding", 400);
    return true;
  }
  const slug = parsedSlug.value;

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
