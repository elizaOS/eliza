/**
 * Thread provider for Farcaster.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { FarcasterService } from "../services/FarcasterService";
import { FARCASTER_SERVICE_NAME, FARCASTER_SOURCE } from "../types";

/**
 * Format timestamp for display.
 */
const formatTimestamp = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
};

export const farcasterThreadProvider: Provider = {
  name: "farcasterThread",
  description:
    "Provides thread context for Farcaster casts so the agent can reference the full conversation.",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State): Promise<ProviderResult> => {
    const source = (message.content as Record<string, unknown>)?.source;

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

    const content = message.content as Record<string, unknown>;
    const messageMetadata = (message.metadata as Record<string, unknown> | undefined) ?? {};
    const castHash =
      content.hash ||
      content.castHash ||
      (content?.metadata as Record<string, unknown>)?.castHash ||
      messageMetadata.castHash ||
      (content?.metadata as Record<string, unknown>)?.parentHash ||
      messageMetadata.parentHash;

    if (!castHash || typeof castHash !== "string") {
      return {
        text: "Unable to resolve Farcaster cast hash for this message.",
        data: { available: false, error: "missing_cast_hash" },
      };
    }

    const threadMessages = await messageService.getThread({
      agentId: runtime.agentId,
      castHash,
    });

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

    const formattedThread = threadMessages
      .map((msg, index) => {
        const time = formatTimestamp(msg.timestamp);
        const username = msg.username || msg.userId || "unknown";
        const marker = index === threadMessages.length - 1 ? "→" : "•";
        const text = msg.text && msg.text.trim().length > 0 ? msg.text : "<no text>";
        return `${marker} [${time}] @${username}: ${text}`;
      })
      .join("\n");

    return {
      text: `# Farcaster Thread Context\n${formattedThread}`,
      data: {
        available: true,
        castHash,
        count: threadMessages.length,
      },
      values: {
        farcasterThread: formattedThread,
        farcasterCastHash: castHash,
        farcasterCurrentCastText: threadMessages[threadMessages.length - 1]?.text ?? "",
        farcasterParentCastText:
          threadMessages.length > 1 ? (threadMessages[threadMessages.length - 2]?.text ?? "") : "",
      },
    };
  },
};
