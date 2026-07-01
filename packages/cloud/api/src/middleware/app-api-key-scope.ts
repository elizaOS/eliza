import type { MiddlewareHandler } from "hono";
import { jsonError } from "@/lib/api/cloud-worker-errors";
import { apiKeysService } from "@/lib/services/api-keys";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const APP_ID_ROUTE_PATTERN =
  /^\/api\/v1\/apps\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/;

export function appIdFromAppsRoute(pathname: string): string | null {
  return APP_ID_ROUTE_PATTERN.exec(pathname)?.[1] ?? null;
}

function readApiKeyToken(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
): string | null {
  const headerKey = c.req.header("X-API-Key") ?? c.req.header("x-api-key");
  if (headerKey?.trim()) return headerKey.trim();

  const authorization = c.req.header("authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
  return bearer?.startsWith("eliza_") ? bearer : null;
}

export const appApiKeyScopeMiddleware: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const appId = appIdFromAppsRoute(new URL(c.req.url).pathname);
  if (!appId) {
    await next();
    return;
  }

  const token = readApiKeyToken(c);
  if (!token) {
    await next();
    return;
  }

  const apiKey = await apiKeysService.validateApiKey(token);
  if (!apiKey) {
    await next();
    return;
  }

  const boundApp = await appsService.getByApiKeyId(apiKey.id);
  if (boundApp && boundApp.id !== appId) {
    logger.warn("[AppApiKeyScope] Rejected app API key for sibling app", {
      requestedAppId: appId,
      boundAppId: boundApp.id,
      apiKeyId: apiKey.id,
      organizationId: apiKey.organization_id,
    });
    return jsonError(c, 403, "Invalid API key for this app", "access_denied");
  }

  await next();
};
