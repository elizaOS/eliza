import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
  UUID,
} from "@elizaos/core";

const PROXIMITY_WINDOW_SIZE = 20;

interface CoParticipant {
  entityId: UUID;
  lastSeen: number;
  messageCount: number;
}

export const conversationProximityProvider: Provider = {
  name: "CONVERSATION_PROXIMITY",
  description:
    "Recent co-participants in the current room with message counts and last-seen timestamps.",
  dynamic: true,
  position: 40,
  cacheStable: false,
  cacheScope: "turn",

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const senderEntityId = message.entityId as UUID | undefined;
    const roomId = message.roomId as UUID | undefined;
    if (!senderEntityId || !roomId) {
      return { text: "", values: {}, data: {} };
    }

    const recentMessages = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: PROXIMITY_WINDOW_SIZE,
      unique: false,
    });

    const coParticipantsById = new Map<string, CoParticipant>();
    for (const memory of recentMessages) {
      const entityId = memory.entityId as UUID | undefined;
      if (
        !entityId ||
        entityId === senderEntityId ||
        entityId === runtime.agentId
      ) {
        continue;
      }
      const previous = coParticipantsById.get(entityId);
      const createdAt = memory.createdAt ?? 0;
      if (previous) {
        previous.messageCount += 1;
        previous.lastSeen = Math.max(previous.lastSeen, createdAt);
      } else {
        coParticipantsById.set(entityId, {
          entityId,
          lastSeen: createdAt,
          messageCount: 1,
        });
      }
    }

    const coParticipants = [...coParticipantsById.values()].sort(
      (left, right) =>
        right.lastSeen - left.lastSeen ||
        right.messageCount - left.messageCount ||
        left.entityId.localeCompare(right.entityId),
    );

    const text =
      coParticipants.length > 0
        ? [
            "Conversation proximity:",
            ...coParticipants.map(
              (participant) =>
                `- ${participant.entityId}: ${participant.messageCount} recent messages, last seen ${participant.lastSeen}`,
            ),
          ].join("\n")
        : "";

    return {
      text,
      values: {
        conversationProximityParticipants: coParticipants,
      },
      data: {
        coParticipants,
      },
    };
  },
};
