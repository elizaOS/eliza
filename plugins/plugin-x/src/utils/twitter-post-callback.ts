/**
 * `createTwitterPostCallback` — the `HandlerCallback` the post loop hands the agent
 * for publishing generated text: it suppresses duplicates, honors
 * `TWITTER_DRY_RUN`, delivers complete text as an ordered thread, and records
 * every provider receipt.
 */
import {
  ChannelType,
  type Content,
  ElizaError,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  parseBooleanFromText,
  type UUID,
} from "@elizaos/core";
import type { ClientBase } from "../base";
import type { TwitterClientState } from "../types";
import { sendChunkedTweet } from "../utils";
import {
  addToRecentTweets,
  createMemorySafe,
  ensureTwitterContext,
  isDuplicateTweet,
} from "./memory";
import { getSetting } from "./settings";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTwitterPostCallback({
  client,
  runtime,
  state,
  roomId,
  userId,
  username: _username,
  onPosted,
}: {
  client: ClientBase;
  runtime: IAgentRuntime;
  state: TwitterClientState;
  roomId: UUID;
  userId: string;
  username: string;
  onPosted?: () => void;
}): HandlerCallback {
  const isDryRun = parseBooleanFromText(
    state?.TWITTER_DRY_RUN ?? getSetting(runtime, "TWITTER_DRY_RUN"),
  );
  let egressAttempted = false;

  const callback: HandlerCallback = async (
    content: Content,
  ): Promise<Memory[]> => {
    try {
      const generatedText =
        typeof content.text === "string" ? content.text : "";
      if (!generatedText.trim()) {
        runtime.logger.warn("[Twitter] No generated tweet text to post");
        return [];
      }

      const postText = generatedText;
      if (isDryRun) {
        runtime.logger.info(
          `[Twitter] [DRY RUN] Would post tweet: ${postText}`,
        );
        return [];
      }

      if (egressAttempted) {
        runtime.logger.warn(
          "[Twitter] Suppressed duplicate generated-post callback egress",
        );
        return [];
      }
      egressAttempted = true;

      return client.withAuthenticatedSession(async (session) => {
        if (session.profile.id !== userId) {
          throw new ElizaError(
            "X profile changed before the generated post was admitted",
            { code: "X_AUTH_SESSION_ROTATED" },
          );
        }

        const cacheIdentity = {
          accountId: client.accountId,
          profileId: session.profile.id,
        };
        const isDuplicate = await isDuplicateTweet(
          runtime,
          cacheIdentity,
          postText,
        );
        if (isDuplicate) {
          runtime.logger.info("[Twitter] Skipping duplicate generated tweet");
          return [];
        }
        const deliveredMemories = await sendChunkedTweet(
          client,
          content,
          roomId,
          session.profile.username,
        );
        const firstTweetId =
          typeof deliveredMemories[0]?.metadata === "object"
            ? (deliveredMemories[0].metadata as { messageIdFull?: string })
                .messageIdFull
            : undefined;
        if (!firstTweetId) {
          throw new ElizaError("X thread delivery returned no usable receipt", {
            code: "X_POST_RESPONSE_INVALID",
          });
        }
        runtime.logger.info(
          `[Twitter] Tweet thread posted successfully! First ID: ${firstTweetId}`,
        );
        try {
          onPosted?.();
        } catch (error) {
          // error-policy:J7 X already accepted the post; the scheduler's
          // notification callback must not convert delivery into a retry.
          runtime.reportError("XPostCallback.notificationReceipt", error, {
            accountId: client.accountId,
            tweetId: firstTweetId,
          });
        }

        try {
          await addToRecentTweets(runtime, cacheIdentity, postText);
        } catch (error) {
          // error-policy:J7 X already accepted the post; local duplicate
          // history failure must be visible without replaying provider egress.
          runtime.reportError("XPostCallback.localReceipt", error, {
            accountId: client.accountId,
            tweetId: firstTweetId,
          });
        }

        try {
          const context = await ensureTwitterContext(runtime, {
            accountId: client.accountId,
            userId: session.profile.id,
            username: session.profile.username,
            conversationId: `${session.profile.id}-home`,
          });

          const postedMemories = deliveredMemories.map((memory) => {
            const tweetId =
              typeof memory.metadata === "object"
                ? (memory.metadata as { messageIdFull?: string }).messageIdFull
                : undefined;
            if (!tweetId) {
              throw new Error(
                "X thread memory is missing its provider receipt",
              );
            }
            return {
              ...memory,
              roomId: (context.roomId || roomId) as UUID,
              content: {
                ...content,
                text: memory.content.text,
                source: "twitter",
                channelType: ChannelType.FEED,
                type: "post",
                metadata: {
                  accountId: client.accountId,
                  tweetId,
                  postedAt: memory.createdAt,
                },
              },
              metadata: {
                type: "message",
                source: "twitter",
                accountId: client.accountId,
                provider: "twitter",
                messageIdFull: tweetId,
                chatType: ChannelType.FEED,
                fromBot: true,
              } satisfies Memory["metadata"],
            } satisfies Memory;
          });

          for (const postedMemory of postedMemories) {
            await createMemorySafe(runtime, postedMemory, "messages");
          }
          return postedMemories;
        } catch (error) {
          // error-policy:J7 X already accepted the post; surface local memory
          // loss without returning an error that could cause duplicate egress.
          runtime.reportError("XPostCallback.memoryReceipt", error, {
            accountId: client.accountId,
            tweetId: firstTweetId,
          });
          return deliveredMemories;
        }
      });
    } catch (error) {
      runtime.logger.error(
        "[Twitter] Error in post generated callback:",
        errorMessage(error),
      );
      throw error;
    }
  };

  return callback;
}
