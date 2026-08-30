/** Navigates an authenticated hosted-browser session. */

import { Hono } from "hono";
import { z } from "zod";
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
  logHostedBrowserFailure,
  navigateHostedBrowserSession,
} from "@/lib/services/browser-tools";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const navigateSchema = z.object({
  url: z.string().trim().url().max(2_000),
});

async function handlePOST(
  c: AppContext,
  context: RouteContext<{ id: string }>,
) {
  try {
    const caller = await requireGenerativeRouteCaller(c);
    const { id } = await context.params;
    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const rawBody = decodedRawBody.value;
    const bodyResult = navigateSchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return Response.json(
        {
          error: "Invalid navigate request",
          details: bodyResult.error.flatten(),
        },
        { status: 400 },
      );
    }

    const session = await navigateHostedBrowserSession(
      id,
      bodyResult.data.url,
      {
        apiKeyId: caller.apiKeyId,
        organizationId: caller.user.organization_id,
        requestSource: "api",
        userId: caller.user.id,
        operationContext: getGenerativeOperationContext(c, caller),
      },
    );

    return Response.json({ session });
  } catch (error) {
    logHostedBrowserFailure("browser_navigate", error);
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handlePOST(c, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});
export default honoRouter;
