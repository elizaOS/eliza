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
      const text = typeof content.text === "string" ? content.text.trim() : "";
      if (!text) {
        runtime.logger.warn("[Twitter] No generated tweet text to post");
        return [];
      }

      if (isDryRun) {
        runtime.logger.info(`[Twitter] [DRY RUN] Would post tweet: ${text}`);
        return [];
      }

      const isDuplicate = await isDuplicateTweet(runtime, username, text);
      if (isDuplicate) {
        runtime.logger.info("[Twitter] Skipping duplicate generated tweet");
        return [];
      }

      const result = await sendTweet(client, text, [], undefined, []);
      runtime.logger.info(
        `[Twitter] Tweet posted successfully! ID: ${result.id}`,
      );
      onPosted?.();

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
        roomId: roomId || context.roomId,
        content: {
          ...content,
          text,
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
      await addToRecentTweets(runtime, username, text);

      return [postedMemory];
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
