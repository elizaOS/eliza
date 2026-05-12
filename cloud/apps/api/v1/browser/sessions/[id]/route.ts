import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getErrorStatusCode, getSafeErrorMessage } from "@/lib/api/errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  deleteHostedBrowserSession,
  getHostedBrowserSession,
  logHostedBrowserFailure,
} from "@/lib/services/browser-tools";
import type { AppEnv } from "@/types/cloud-worker-env";

type RouteContext = {
  params: Promise<{ id: string }>;
};

async function handleGET(request: Request, context: RouteContext) {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await context.params;
    const session = await getHostedBrowserSession(id, {
      apiKeyId: authResult.apiKey?.id ?? null,
      organizationId: authResult.user.organization_id,
      requestSource: "api",
      userId: authResult.user.id,
    });
    return Response.json({ session });
  } catch (error) {
    logHostedBrowserFailure("browser_get", error);
    return Response.json(
      { error: getSafeErrorMessage(error) },
      { status: getErrorStatusCode(error) },
    );
  }
}

async function handleDELETE(request: Request, context: RouteContext) {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await context.params;
    const result = await deleteHostedBrowserSession(id, {
      apiKeyId: authResult.apiKey?.id ?? null,
      organizationId: authResult.user.organization_id,
      requestSource: "api",
      userId: authResult.user.id,
    });
    return Response.json({
      closed: result.success === true,
      creditsBilled: result.creditsBilled ?? null,
      sessionDurationMs: result.sessionDurationMs ?? null,
    });
  } catch (error) {
    logHostedBrowserFailure("browser_delete", error);
    return Response.json(
      { error: getSafeErrorMessage(error) },
      { status: getErrorStatusCode(error) },
    );
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handleGET(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
honoRouter.delete("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handleDELETE(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
