import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getErrorStatusCode, getSafeErrorMessage } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { executeHostedGoogleSearch } from "@/lib/services/google-search";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).max(10).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  source: z.string().trim().min(1).max(255).optional(),
  topic: z.enum(["general", "finance"]).optional(),
  timeRange: z.enum(["day", "week", "month", "year", "d", "w", "m", "y"]).optional(),
  startDate: z.string().trim().min(1).max(32).optional(),
  endDate: z.string().trim().min(1).max(32).optional(),
});

async function handlePOST(req: Request) {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(req);
    const bodyResult = searchRequestSchema.safeParse(await req.json());

    if (!bodyResult.success) {
      return Response.json(
        {
          error: "Invalid search request",
          details: bodyResult.error.flatten(),
        },
        { status: 400 },
      );
    }

    const body = bodyResult.data;
    const result = await executeHostedGoogleSearch(
      {
        query: body.query,
        maxResults: body.maxResults,
        model: body.model,
        source: body.source,
        topic: body.topic,
        timeRange: body.timeRange,
        startDate: body.startDate,
        endDate: body.endDate,
      },
      {
        organizationId: authResult.user.organization_id,
        userId: authResult.user.id,
        apiKeyId: authResult.apiKey?.id ?? null,
        requestSource: "api",
      },
    );

    return Response.json(result);
  } catch (error) {
    logger.error("[/api/v1/search] Request failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    return Response.json(
      {
        error: getSafeErrorMessage(error),
      },
      { status: getErrorStatusCode(error) },
    );
  }
}

const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handlePOST(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
