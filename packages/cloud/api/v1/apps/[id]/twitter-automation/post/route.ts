// Handles v1 cloud API v1 apps id twitter automation post route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import {
  asGenerativeCacheApiError,
  getGenerativeOperationContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import type { RouteContext } from "@/lib/api/hono-next-style-params";
import {
  type GenerativeOperationContext,
  isGenerativeOperationAdmissionError,
} from "@/lib/services/generative-operation";
import { twitterAppAutomationService } from "@/lib/services/twitter-automation/app-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const PostTweetSchema = z.object({
  text: z.string().max(280).optional(),
  type: z
    .enum(["promotional", "engagement", "educational", "announcement"])
    .optional(),
});

async function __hono_POST(
  request: Request,
  { params }: RouteContext<{ id: string }>,
  caller: Awaited<ReturnType<typeof requireGenerativeRouteCaller>>,
  operationContext: GenerativeOperationContext,
): Promise<Response> {
  const { user } = caller;
  const { id } = await params;
  if (caller.appScopeId && caller.appScopeId !== id) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = PostTweetSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  logger.info("[Twitter Automation API] Posting tweet for app", {
    appId: id,
    userId: user.id,
    hasCustomText: !!parsed.data.text,
  });

  try {
    const result = await twitterAppAutomationService.postAppTweet(
      user.organization_id,
      id,
      parsed.data.text,
      operationContext,
    );

    if (!result.success) {
      const status = result.error === "App not found" ? 404 : 400;
      return Response.json(
        { error: result.error || "Failed to post tweet" },
        { status },
      );
    }

    return Response.json({
      success: true,
      tweetId: result.tweetId,
      tweetUrl: result.tweetUrl,
    });
  } catch (error) {
    if (isGenerativeOperationAdmissionError(error)) throw error;
    if (error instanceof Error && error.message === "App not found") {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    logger.error("[Twitter Automation API] Failed to post tweet", {
      appId: id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json(
      { error: "Failed to post tweet. Please try again." },
      { status: 500 },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => {
  try {
    const caller = await requireGenerativeRouteCaller(c, {
      rateLimitEndpoint: "strict",
    });
    return await __hono_POST(
      c.req.raw,
      { params: Promise.resolve({ id: c.req.param("id")! }) },
      caller,
      getGenerativeOperationContext(c, caller),
    );
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});
export default __hono_app;
