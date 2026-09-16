// Handles v1 cloud API v1 browser sessions id route traffic with route-local auth expectations.
import { Hono } from "hono";
import {
  asGenerativeCacheApiError,
  getGenerativeOperationContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  nextStyleParams,
  type RouteContext,
} from "@/lib/api/hono-next-style-params";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  deleteHostedBrowserSession,
  getHostedBrowserSession,
  logHostedBrowserFailure,
} from "@/lib/services/browser-tools";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

async function handleGET(c: AppContext, context: RouteContext<{ id: string }>) {
  try {
    const caller = await requireGenerativeRouteCaller(c);
    const { id } = await context.params;
    const session = await getHostedBrowserSession(id, {
      apiKeyId: caller.apiKeyId,
      organizationId: caller.user.organization_id,
      requestSource: "api",
      userId: caller.user.id,
      operationContext: getGenerativeOperationContext(c, caller),
    });
    return Response.json({ session });
  } catch (error) {
    logHostedBrowserFailure("browser_get", error);
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
}

async function handleDELETE(
  c: AppContext,
  context: RouteContext<{ id: string }>,
) {
  try {
    const caller = await requireGenerativeRouteCaller(c);
    const { id } = await context.params;
    const result = await deleteHostedBrowserSession(id, {
      apiKeyId: caller.apiKeyId,
      organizationId: caller.user.organization_id,
      requestSource: "api",
      userId: caller.user.id,
      operationContext: getGenerativeOperationContext(c, caller),
    });
    return Response.json({
      closed: result.success === true,
      creditsBilled: result.creditsBilled ?? null,
      sessionDurationMs: result.sessionDurationMs ?? null,
    });
  } catch (error) {
    logHostedBrowserFailure("browser_delete", error);
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handleGET(c, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});
honoRouter.delete("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handleDELETE(c, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});
export default honoRouter;
