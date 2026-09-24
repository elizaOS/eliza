/** Supplies nonempty topic hints for shared channels; private dialogue does not
 * publish or consume channel topic state. Provider failures remain unavailable
 * rather than pretending the room has no topics. */

import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { ChannelTopicsService, ChannelType } from "@elizaos/core";

const EMPTY_RESULT = { text: "", values: {}, data: {} } as const;
const UNAVAILABLE_RESULT = {
  text: "# Current topics unavailable",
  values: { channelTopicsUnavailable: true },
  data: { unavailable: true },
} as const;

export const channelTopicsProvider: Provider = {
  name: "CHANNEL_TOPICS",
  description:
    "Recent topic labels for this channel (LRU). Hint for routing/relevance; never gates action selection.",
  dynamic: true,
  position: -4,
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const channelType = message.content.channelType;
    if (
      channelType !== ChannelType.GROUP &&
      channelType !== ChannelType.VOICE_GROUP &&
      channelType !== ChannelType.THREAD &&
      channelType !== ChannelType.WORLD &&
      channelType !== ChannelType.FORUM &&
      channelType !== ChannelType.FEED
    )
      return { ...EMPTY_RESULT };
    const service = runtime.getService<ChannelTopicsService>(
      ChannelTopicsService.serviceType,
    );
    if (!service) {
      return { ...EMPTY_RESULT };
    }
    const roomId = message.roomId;
    if (!roomId) {
      return { ...EMPTY_RESULT };
    }
    let topics: string[] = [];
    try {
      topics = await service.ensureHydrated(roomId);
    } catch {
      // error-policy:J4 The service reports database failures through the
      // runtime; this explicit state keeps failure distinct from an empty LRU.
      return { ...UNAVAILABLE_RESULT };
    }
    if (topics.length === 0) {
      return { ...EMPTY_RESULT };
    }
    // Most-recent last in the LRU; show most-recent first for readability.
    const ordered = [...topics].reverse();
    const text = `Topics (hints): ${ordered.join(", ")}`;
    return {
      text,
      values: { channelTopics: ordered.join(", ") },
      data: { topics: ordered },
    };
  },
};
