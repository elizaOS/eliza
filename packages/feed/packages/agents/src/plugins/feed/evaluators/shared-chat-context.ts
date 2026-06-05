import type { Evaluator, JSONSchema, Memory, State } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { logger } from "../../../shared/logger";

type StoredSnapshot = {
  chatId: string;
  chatName: string | null;
  summary: string;
  facts: string[];
  participantNames: string[];
  messageCount: number;
  lastMessageAt: string;
  refreshedAt: string;
};

type SharedChatContextServiceShape = {
  getStoredSnapshot: (chatId: string) => Promise<StoredSnapshot | null>;
  maybeRefreshChatContext: (
    chatId: string,
    options: {
      messageWindowSize?: number;
      factLimit?: number;
      staleAfterMinutes?: number;
      refreshThreshold?: number;
    },
  ) => Promise<StoredSnapshot | null>;
};

const SHARED_CHAT_CONTEXT_SERVICE_PATH =
  "../../../../../engine/src/services/shared-chat-context-service";

let sharedChatContextServicePromise: Promise<SharedChatContextServiceShape> | null =
  null;

async function getSharedChatContextService(): Promise<SharedChatContextServiceShape> {
  if (!sharedChatContextServicePromise) {
    sharedChatContextServicePromise = import(
      SHARED_CHAT_CONTEXT_SERVICE_PATH
    ).then(
      (module) =>
        module.sharedChatContextService as SharedChatContextServiceShape,
    );
  }

  return sharedChatContextServicePromise;
}

const CACHE_PREFIX = "shared-chat-context:last-message-count";
const MIN_MESSAGES_BEFORE_REFRESH = 3;
const REFRESH_EVERY_MESSAGES = 10;
const STALE_AFTER_MINUTES = 30;
const RUN_SCHEMA = {
  type: "object",
  properties: {
    run: { type: "boolean" },
  },
  required: ["run"],
  additionalProperties: false,
} satisfies JSONSchema;

function resolveChatId(message: Memory, state?: State): string | null {
  const typedMessage = message as Memory & {
    chatId?: string;
    roomId?: string;
  };

  return (
    typedMessage.chatId ??
    typedMessage.roomId ??
    (state?.values?.teamChatId as string | undefined) ??
    null
  );
}

export const sharedChatContextEvaluator: Evaluator<{ run: boolean }> = {
  name: "SHARED_CHAT_CONTEXT_EVALUATOR",
  similes: [
    "group chat summarizer",
    "shared chat memory",
    "conversation context",
  ],
  description:
    "Refreshes compact shared group chat summaries and facts on a low-cost cadence",
  schema: RUN_SCHEMA,
  modelType: ModelType.TEXT_NANO,

  async shouldRun({ runtime, message, state }): Promise<boolean> {
    const chatId = resolveChatId(message, state);
    if (!chatId) {
      return false;
    }

    const cacheKey = `${CACHE_PREFIX}:${chatId}`;
    const currentCount =
      Number((await runtime.getCache<string>(cacheKey)) ?? "0") + 1;
    await runtime.setCache(cacheKey, String(currentCount));

    if (currentCount < MIN_MESSAGES_BEFORE_REFRESH) {
      return false;
    }

    const sharedChatContextService = await getSharedChatContextService();
    const storedSnapshot =
      await sharedChatContextService.getStoredSnapshot(chatId);
    if (!storedSnapshot) {
      return true;
    }

    const isOnCadence = currentCount % REFRESH_EVERY_MESSAGES === 0;
    const isStale =
      Date.now() - new Date(storedSnapshot.refreshedAt).getTime() >=
      STALE_AFTER_MINUTES * 60_000;

    if (isOnCadence || isStale) {
      logger.info(
        "[sharedChatContextEvaluator] refreshing shared chat context",
        {
          chatId,
          currentCount,
          isOnCadence,
          isStale,
        },
        "SharedChatContextEvaluator",
      );
      return true;
    }

    return false;
  },

  prompt() {
    return 'Return {"run":true} to refresh the shared chat context.';
  },

  parse(): { run: boolean } {
    return { run: true };
  },

  processors: [
    {
      name: "refreshSharedChatContext",
      async process({ message, state }) {
        const chatId = resolveChatId(message, state);
        if (!chatId) {
          return undefined;
        }

        const sharedChatContextService = await getSharedChatContextService();
        await sharedChatContextService.maybeRefreshChatContext(chatId, {
          messageWindowSize: 10,
          factLimit: 5,
          staleAfterMinutes: STALE_AFTER_MINUTES,
          refreshThreshold: REFRESH_EVERY_MESSAGES,
        });
        return undefined;
      },
    },
  ],
};
