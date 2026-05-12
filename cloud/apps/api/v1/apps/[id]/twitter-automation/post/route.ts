import { Hono } from "hono";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { twitterAppAutomationService } from "@/lib/services/twitter-automation/app-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const PostTweetSchema = z.object({
  text: z.string().max(280).optional(),
  type: z.enum(["promotional", "engagement", "educational", "announcement"]).optional(),
});

async function __hono_POST(request: Request, { params }: RouteParams): Promise<Response> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

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
    );

    if (!result.success) {
      const status = result.error === "App not found" ? 404 : 400;
      return Response.json({ error: result.error || "Failed to post tweet" }, { status });
    }

    return Response.json({
      success: true,
      tweetId: result.tweetId,
      tweetUrl: result.tweetUrl,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "App not found") {
      return Response.json({ error: "App not found" }, { status: 404 });
    }
    if (error instanceof Error && error.message.includes("Insufficient credits")) {
      return Response.json({ error: error.message }, { status: 402 });
    }
    logger.error("[Twitter Automation API] Failed to post tweet", {
      appId: id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return Response.json({ error: "Failed to post tweet. Please try again." }, { status: 500 });
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, { params: Promise.resolve({ id: c.req.param("id")! }) }),
);
export default __hono_app;
