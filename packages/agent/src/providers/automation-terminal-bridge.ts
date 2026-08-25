/**
 * Provider that injects recent messages from the terminal conversation linked
 * to the current automation room, giving an automation-context agent visibility
 * into the operator-facing terminal side. Reads the linked conversation id from
 * the room's automation metadata, loads that room's latest messages, and renders
 * them oldest-first. Gated to ADMIN and scoped to the automation /
 * agent_internal contexts.
 */
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  UUID,
} from "@elizaos/core";
import { logger, stringToUuid, toWellFormedUnicode } from "@elizaos/core";
import {
  extractConversationMetadataFromRoom,
  isAutomationConversationMetadata,
} from "../api/conversation-metadata.ts";
import { hasAdminAccess } from "../security/access.ts";
import {
  formatRelativeTimestampPrefix,
  formatSpeakerLabel,
} from "../shared/conversation-format.ts";

/**
 * Normalizes a memory timestamp for ordering. A missing or non-finite
 * `createdAt` (NaN reaches this provider when a storage row carries an
 * unparseable timestamp) would otherwise make every comparison return NaN,
 * which the sort treats as "equal" and leaves the transcript in whatever order
 * storage returned it. Collapsing those to 0 keeps the ordering total so the
 * oldest-first transcript stays deterministic.
 */
export function safeCreatedAt(createdAt: number | undefined): number {
  return Number.isFinite(createdAt) ? (createdAt as number) : 0;
}

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
      });
      const visibleMessages = memories
        .filter((entry) => entry.content.text)
        .sort(
          (left, right) =>
            safeCreatedAt(left.createdAt) - safeCreatedAt(right.createdAt),
        );

      if (visibleMessages.length === 0) {
        return { text: "", values: {}, data: {} };
      }

      const lines = ["Linked terminal conversation:"];
      for (const mem of visibleMessages) {
        const speaker = formatSpeakerLabel(runtime, mem);
        const age = formatRelativeTimestampPrefix(mem.createdAt);
        const text = toWellFormedUnicode(mem.content.text ?? "");
        lines.push(`${age}${speaker}: ${text}`);
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
