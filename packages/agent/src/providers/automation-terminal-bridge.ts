import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  UUID,
} from "@elizaos/core";
import { logger, stringToUuid } from "@elizaos/core";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
} from "../api/conversation-metadata.ts";
import { hasAdminAccess } from "../security/access.ts";
import {
  formatRelativeTimestamp,
  formatSpeakerLabel,
} from "../shared/conversation-format.ts";

const MAX_TERMINAL_MESSAGES = 8;

export const automationTerminalBridgeProvider: Provider = {
  name: "automation-terminal-bridge",
  description:
    "Recent messages from the linked terminal conversation for the current automation room.",
  descriptionCompressed:
    "recent message link terminal conversation current automation room",
  dynamic: true,
  position: 5,
  contexts: ["automation", "agent_internal"],
  contextGate: { anyOf: ["automation", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "ADMIN" },

  async get(runtime: IAgentRuntime, message: Memory): Promise<ProviderResult> {
    if (!(await hasAdminAccess(runtime, message))) {
      return { text: "", values: {}, data: {} };
    }

    try {
      const currentRoom = await runtime.getRoom(message.roomId);
      const metadata = extractConversationMetadataFromRoom(currentRoom);
      if (!isAutomationConversationMetadata(metadata)) {
        return { text: "", values: {}, data: {} };
      }

      const terminalConversationId = metadata?.terminalBridgeConversationId;
      if (!terminalConversationId) {
        return { text: "", values: {}, data: {} };
      }

      const sourceRoomId = stringToUuid(
        `web-conv-${terminalConversationId}`,
      ) as UUID;
      if (sourceRoomId === message.roomId) {
        return { text: "", values: {}, data: {} };
      }

      const memories = await runtime.getMemories({
        roomId: sourceRoomId,
        tableName: "messages",
        limit: MAX_TERMINAL_MESSAGES,
      });
      const visibleMessages = memories
        .filter((entry) => entry.content?.text)
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
        .slice(-MAX_TERMINAL_MESSAGES);

      if (visibleMessages.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      const lines = ["Linked terminal conversation:"];
      for (const mem of visibleMessages) {
        const speaker = formatSpeakerLabel(runtime, mem);
        const ts = formatRelativeTimestamp(mem.createdAt);
        const text = (mem.content.text ?? "").slice(0, 300);
        lines.push(`(${ts}) ${speaker}: ${text}`);
      }

      return {
        text: lines.join("\n"),
        values: {
          terminalBridgeConversationId: terminalConversationId,
          terminalBridgeMessageCount: visibleMessages.length,
        },
        data: {
          conversationId: terminalConversationId,
          messages: visibleMessages.map((entry) => ({
            id: entry.id,
            roomId: entry.roomId,
            entityId: entry.entityId,
            text: entry.content.text,
            createdAt: entry.createdAt,
          })),
        },
      };
    } catch (error) {
      logger.error(
        "[automation-terminal-bridge] Error:",
        error instanceof Error ? error.message : String(error),
      );
      return { text: "", values: {}, data: {} };
    }
  },
};
