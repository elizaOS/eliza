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
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  parseBooleanFromText,
  type UUID,
} from "@elizaos/core";
import type { ClientBase } from "../base";
import { TWEET_MAX_LENGTH } from "../constants";
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
  if (text.length <= TWEET_MAX_LENGTH) {
    return text;
  }

  const sentenceMatches = text.match(/[^.!?]+[.!?]+/g) || [];
  let sentenceText = "";
  for (const sentence of sentenceMatches) {
    if ((sentenceText + sentence).trim().length <= TWEET_MAX_LENGTH) {
      sentenceText += sentence;
    } else {
      break;
    }
  }
  if (sentenceText.trim()) {
    return sentenceText.trim();
  }

  const spaceIndex = text.lastIndexOf(" ", TWEET_MAX_LENGTH - 4);
  if (spaceIndex > 0) {
    return `${text.slice(0, spaceIndex).trim()}...`;
  }

  return `${text.slice(0, TWEET_MAX_LENGTH - 3).trim()}...`;
}

export function createTwitterPostCallback({
  client,
  runtime,
  state,
  roomId,
  userId,
  username,
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

      const isDuplicate = await isDuplicateTweet(runtime, username, postText);
      if (isDuplicate) {
        runtime.logger.info("[Twitter] Skipping duplicate generated tweet");
        return [];
      }

      const result = await sendTweet(client, postText, [], undefined, []);
      const postedText = result.text?.trim() || postText;
      runtime.logger.info(
        `[Twitter] Tweet posted successfully! ID: ${result.id}`,
      );
      onPosted?.();
      await addToRecentTweets(runtime, username, postedText);

      try {
        const context = await ensureTwitterContext(runtime, {
          accountId: client.accountId,
          userId,
          username,
          conversationId: `${userId}-home`,
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
        runtime.logger.error(
          "[Twitter] Tweet posted, but failed to save tweet memory:",
          errorMessage(error),
        );
        return [];
      }
    } catch (error) {
      runtime.logger.error(
        "[Twitter] Error in post generated callback:",
        errorMessage(error),
      );
      return [];
    }
  };

  return callback;
}
