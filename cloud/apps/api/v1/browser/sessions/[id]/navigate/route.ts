import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getErrorStatusCode, getSafeErrorMessage } from "@/lib/api/errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  logHostedBrowserFailure,
  navigateHostedBrowserSession,
} from "@/lib/services/browser-tools";
import type { AppEnv } from "@/types/cloud-worker-env";

type RouteContext = {
  params: Promise<{ id: string }>;
};

const navigateSchema = z.object({
  url: z.string().trim().url().max(2_000),
});

async function handlePOST(request: Request, context: RouteContext) {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await context.params;
    const bodyResult = navigateSchema.safeParse(await request.json());
    if (!bodyResult.success) {
      return Response.json(
        {
          error: "Invalid navigate request",
          details: bodyResult.error.flatten(),
        },
        { status: 400 },
      );
    }

    const session = await navigateHostedBrowserSession(id, bodyResult.data.url, {
      apiKeyId: authResult.apiKey?.id ?? null,
      organizationId: authResult.user.organization_id,
      requestSource: "api",
      userId: authResult.user.id,
    });

    return Response.json({ session });
  } catch (error) {
    logHostedBrowserFailure("browser_navigate", error);
    return Response.json(
      { error: getSafeErrorMessage(error) },
      { status: getErrorStatusCode(error) },
    );
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handlePOST(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
