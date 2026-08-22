/**
 * `createTwitterPostCallback` — the `HandlerCallback` the post loop hands the agent
 * for publishing a generated tweet: it normalizes text to the X length limit,
 * suppresses duplicate generations, honors `TWITTER_DRY_RUN`, publishes via the
 * client, and records the resulting memory (returning it even when the post-publish
 * persistence step fails).
 */
import {
  ChannelType,
  type Content,
  createUniqueUuid,
  ElizaError,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  parseBooleanFromText,
  type UUID,
} from "@elizaos/core";
import type { ClientBase } from "../base";
import { TWEET_MAX_LENGTH } from "../constants";
import {
  countTwitterWeightedLength,
  truncateToTwitterWeightedLength,
} from "../tweet-length";
import type { TwitterClientState } from "../types";
import { sendTweet } from "../utils";
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

function normalizePostText(text: string): string {
  if (countTwitterWeightedLength(text) <= TWEET_MAX_LENGTH) {
    return text;
  }

  const sentenceMatches = text.match(/[^.!?]+[.!?]+/g) || [];
  let sentenceText = "";
  for (const sentence of sentenceMatches) {
    const candidate = `${sentenceText}${sentence}`.trim();
    if (countTwitterWeightedLength(candidate) <= TWEET_MAX_LENGTH) {
      sentenceText += sentence;
    } else {
      break;
    }
  }
  if (sentenceText.trim()) {
    return sentenceText.trim();
  }

  const truncated = truncateToTwitterWeightedLength(text, TWEET_MAX_LENGTH - 3);
  const spaceIndex = truncated.lastIndexOf(" ");
  if (spaceIndex > 0) {
    return `${truncated.slice(0, spaceIndex).trim()}...`;
  }
  if (truncated.trim()) {
    return `${truncated.trim()}...`;
  }
  return truncateToTwitterWeightedLength(text, TWEET_MAX_LENGTH);
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
        typeof content.text === "string" ? content.text.trim() : "";
      if (!generatedText) {
        runtime.logger.warn("[Twitter] No generated tweet text to post");
        return [];
      }

      const postText = normalizePostText(generatedText);
      if (postText !== generatedText) {
        runtime.logger.warn(
          `[Twitter] Generated tweet exceeded ${TWEET_MAX_LENGTH} characters; posting truncated text`,
        );
      }

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
        const result = await sendTweet(client, postText, [], undefined, []);
        const postedText = result.text?.trim() || postText;
        runtime.logger.info(
          `[Twitter] Tweet posted successfully! ID: ${result.id}`,
        );
        try {
          onPosted?.();
        } catch (error) {
          // error-policy:J7 X already accepted the post; the scheduler's
          // notification callback must not convert delivery into a retry.
          runtime.reportError("XPostCallback.notificationReceipt", error, {
            accountId: client.accountId,
            tweetId: result.id,
          });
        }

        try {
          await addToRecentTweets(runtime, cacheIdentity, postedText);
        } catch (error) {
          // error-policy:J7 X already accepted the post; local duplicate
          // history failure must be visible without replaying provider egress.
          runtime.reportError("XPostCallback.localReceipt", error, {
            accountId: client.accountId,
            tweetId: result.id,
          });
        }

        try {
          const context = await ensureTwitterContext(runtime, {
            accountId: client.accountId,
            userId: session.profile.id,
            username: session.profile.username,
            conversationId: `${session.profile.id}-home`,
          });

          const postedMemory: Memory = {
            id: createUniqueUuid(runtime, result.id),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: context.roomId || roomId,
            content: {
              ...content,
              text: postedText,
              source: "twitter",
              channelType: ChannelType.FEED,
              type: "post",
              metadata: {
                accountId: client.accountId,
                tweetId: result.id,
                postedAt: Date.now(),
              },
            },
            metadata: {
              type: "message",
              source: "twitter",
              accountId: client.accountId,
              provider: "twitter",
              messageIdFull: result.id,
              chatType: ChannelType.FEED,
              fromBot: true,
            } satisfies Memory["metadata"],
            createdAt: Date.now(),
          };

          await createMemorySafe(runtime, postedMemory, "messages");

          return [postedMemory];
        } catch (error) {
          // error-policy:J7 X already accepted the post; surface local memory
          // loss without returning an error that could cause duplicate egress.
          runtime.reportError("XPostCallback.memoryReceipt", error, {
            accountId: client.accountId,
            tweetId: result.id,
          });
          return [];
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
