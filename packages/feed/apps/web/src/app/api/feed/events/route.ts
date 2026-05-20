import {
  authenticate,
  checkRateLimitAsync,
  ensureUserForAuth,
  RATE_LIMIT_CONFIGS,
  rateLimitError,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { db, feedEvents } from "@feed/db";
import { type FeedEventPayload, generateSnowflakeId } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const FeedEventSchema = z.object({
  actionType: z.enum([
    "impression",
    "visible_2s",
    "open_post",
    "open_article",
    "open_market",
    "like",
    "share",
    "comment",
    "follow",
    "hide",
    "trade_after_view",
  ]),
  surface: z.enum([
    "for_you",
    "following",
    "trades",
    "latest",
    "hot",
    "stories",
  ]),
  itemId: z.string().min(1).max(100),
  itemType: z.enum(["post", "article", "market"]),
  clusterId: z.string().max(100).nullable().optional(),
  marketId: z.string().max(100).nullable().optional(),
  topicKey: z.string().max(80).nullable().optional(),
  authorId: z.string().max(100).nullable().optional(),
  feedPosition: z.number().int().min(0).max(500).optional(),
  dwellMs: z.number().int().min(0).max(300000).optional(),
}) satisfies z.ZodType<FeedEventPayload>;

const BodySchema = z.object({
  events: z.array(FeedEventSchema).min(1).max(25),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const { user } = await ensureUserForAuth(authUser, {
    displayName: authUser.walletAddress
      ? `${authUser.walletAddress.slice(0, 6)}...${authUser.walletAddress.slice(-4)}`
      : "Anonymous",
  });
  const rateLimit = await checkRateLimitAsync(
    user.id,
    RATE_LIMIT_CONFIGS.FEED_EVENT_BATCH,
  );
  if (!rateLimit.allowed) {
    return rateLimitError(rateLimit.retryAfter ?? 60);
  }
  const body = BodySchema.parse(await request.json());

  const rows = await Promise.all(
    body.events.map(async (event) => ({
      id: await generateSnowflakeId(),
      userId: user.id,
      surface: event.surface,
      actionType: event.actionType,
      itemId: event.itemId,
      itemType: event.itemType,
      clusterId: event.clusterId ?? null,
      marketId: event.marketId ?? null,
      topicKey: event.topicKey ?? null,
      authorId: event.authorId ?? null,
      feedPosition: event.feedPosition ?? null,
      dwellMs: event.dwellMs ?? null,
    })),
  );

  await db.insert(feedEvents).values(rows);

  return successResponse({
    success: true,
    accepted: body.events.length,
  });
});

export type FeedEventRequest = {
  events: FeedEventPayload[];
};
