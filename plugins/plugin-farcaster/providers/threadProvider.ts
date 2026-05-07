import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { FarcasterService } from "../services/FarcasterService";
import { FARCASTER_SERVICE_NAME, FARCASTER_SOURCE } from "../types";

const formatTimestamp = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
};

const spec = requireProviderSpec("farcasterThread");
const MAX_THREAD_MESSAGES_IN_STATE = 25;
const MAX_CAST_TEXT_LENGTH = 500;

const truncateCastText = (text: string): string => {
  return text.length > MAX_CAST_TEXT_LENGTH ? `${text.slice(0, MAX_CAST_TEXT_LENGTH)}...` : text;
};

export const farcasterThreadProvider: Provider = {
  name: spec.name,
  description:
    "Provides thread context for Farcaster casts so the agent can reference the full conversation.",
  descriptionCompressed: "provide thread context Farcaster cast agent reference full conversation",

  dynamic: true,
  contexts: ["social_posting", "messaging", "connectors"],
  contextGate: { anyOf: ["social_posting", "messaging", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const contentForSource = message.content as Record<
      string,
      string | number | boolean | null | object | undefined
    >;
    const source =
      typeof contentForSource.source === "string" ? contentForSource.source : undefined;

    if (source !== FARCASTER_SOURCE) {
      return {
        text: "",
        data: {
          available: false,
          reason: `Not a Farcaster message (source=${source ?? "unknown"})`,
        },
      };
    }

    const service = runtime.getService(FARCASTER_SERVICE_NAME) as FarcasterService | null;
    const messageService = service?.getMessageService(runtime.agentId);

    if (!messageService) {
      return {
        text: "Farcaster message service not available.",
        data: { available: false, error: "service_unavailable" },
      };
    }

    const content = message.content as {
      hash?: string;
      castHash?: string;
      metadata?: Record<string, string | undefined> | string;
    };
    const messageMetadata =
      (message.metadata as Record<string, string | undefined> | undefined) ?? {};
    const contentMetadata =
      typeof content.metadata === "object" &&
      content.metadata !== null &&
      !Array.isArray(content.metadata)
        ? content.metadata
        : undefined;
    const castHash =
      content.hash ||
      content.castHash ||
      contentMetadata?.castHash ||
      messageMetadata.castHash ||
      contentMetadata?.parentHash ||
      messageMetadata.parentHash;

    if (!castHash || typeof castHash !== "string") {
      return {
        text: "Unable to resolve Farcaster cast hash for this message.",
        data: { available: false, error: "missing_cast_hash" },
      };
    }

    let threadMessages;
    try {
      threadMessages = await messageService.getThread({
        agentId: runtime.agentId,
        castHash,
      });
    } catch (error) {
      return {
        text: "Unable to load Farcaster thread context.",
        data: {
          available: false,
          castHash,
          error: error instanceof Error ? error.message : String(error),
        },
        values: {},
      };
    }

    if (!threadMessages || threadMessages.length === 0) {
      runtime.logger.debug(
        { castHash },
        "[FarcasterThreadProvider] No thread messages retrieved for cast."
      );
      return {
        text: "No Farcaster thread context available.",
        data: { available: false, castHash, count: 0 },
      };
    }

    const shownThreadMessages = threadMessages.slice(-MAX_THREAD_MESSAGES_IN_STATE);
    const formattedThread = shownThreadMessages
      .map((msg, index) => {
        const time = formatTimestamp(msg.timestamp);
        const username = msg.username || msg.userId || "unknown";
        const marker = index === shownThreadMessages.length - 1 ? "→" : "•";
        const text =
          msg.text && msg.text.trim().length > 0 ? truncateCastText(msg.text) : "<no text>";
        return `${marker} [${time}] @${username}: ${text}`;
      })
      .join("\n");

    return {
      text: `# Farcaster Thread Context\n${formattedThread}`,
      data: {
        available: true,
        castHash,
        count: threadMessages.length,
        shown: shownThreadMessages.length,
        truncated: threadMessages.length > shownThreadMessages.length,
      },
      values: {
        farcasterThread: formattedThread,
        farcasterCastHash: castHash,
        farcasterCurrentCastText: truncateCastText(
          threadMessages[threadMessages.length - 1]?.text ?? ""
        ),
        farcasterParentCastText:
          threadMessages.length > 1
            ? truncateCastText(threadMessages[threadMessages.length - 2]?.text ?? "")
            : "",
      },
    };
  },
};
