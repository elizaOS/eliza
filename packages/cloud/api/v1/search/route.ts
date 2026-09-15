// Handles v1 cloud API v1 search route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import {
  asGenerativeCacheApiError,
  getGenerativeOperationContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getErrorStatusCode, getSafeErrorMessage } from "@/lib/api/errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import { executeHostedGoogleSearch } from "@/lib/services/google-search";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  maxResults: z.number().int().min(1).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  source: z.string().trim().min(1).max(255).optional(),
  topic: z.enum(["general", "finance"]).optional(),
  timeRange: z
    .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
    .optional(),
  startDate: z.string().trim().min(1).max(32).optional(),
  endDate: z.string().trim().min(1).max(32).optional(),
});

async function handlePOST(c: AppContext) {
  try {
    let raw: unknown;
    let pendingResponse: Response | undefined;
    try {
      raw = await c.req.raw.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // error-policy:J3 malformed JSON is an explicit invalid request.
      pendingResponse = Response.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }
    const bodyResult = searchRequestSchema.safeParse(raw);

    if (!bodyResult.success) {
      pendingResponse ??= Response.json(
        {
          error: "Invalid search request",
          details: bodyResult.error.flatten(),
        },
        { status: 400 },
      );
    }

    const caller = await requireGenerativeRouteCaller(c, {
      compatibility: "raw",
      rateLimitEndpoint: "standard",
      deferStrongCredentialCheck: pendingResponse === undefined,
    });
    await using credentialGuard = deferredCredentialAdmissionGuard({
      organizationId: () => caller.user.organization_id,
      credential: () => caller.credential,
    });
    if (pendingResponse) return pendingResponse;
    if (!bodyResult.success) throw bodyResult.error;
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
        ...getGenerativeOperationContext(c, caller, {
          credentialForAdmission: () =>
            credentialGuard.credentialForAdmission(),
        }),
        requestSource: "api",
      },
    );

    return Response.json(result);
  } catch (error) {
    logger.error("[/api/v1/search] Request failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    const admissionError = asGenerativeCacheApiError(error);
    if (admissionError) return failureResponse(c, admissionError);

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
    return await handlePOST(c);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
