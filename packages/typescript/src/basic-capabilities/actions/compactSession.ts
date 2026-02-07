/**
 * Compact Session Action
 *
 * Summarizes conversation history using an LLM, stores the summary as a
 * message, then sets a compaction point on the room.  Messages before the
 * compaction point are excluded from future context, while the summary
 * preserves key decisions, facts, and open items.
 */

import crypto from "node:crypto";
import { logger } from "../../logger.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
  UUID,
} from "../../types/index.ts";
import { MemoryType, ModelType } from "../../types/index.ts";

/**
 * Maximum characters to include in the summarisation prompt.
 * ~25 000 tokens at ~3 chars/token — well within TEXT_LARGE limits.
 */
const MAX_SUMMARY_INPUT_CHARS = 75_000;

function buildSummaryPrompt(
  messages: string,
  instructions?: string,
  previousSummary?: string,
): string {
  let prompt = "";
  if (previousSummary) {
    prompt += `Previous context summary:\n${previousSummary}\n\n`;
  }
  prompt +=
    "Summarize this conversation for context preservation. Focus on decisions, " +
    "facts learned, open questions, action items, and key context needed to continue.\n\n" +
    "Conversation:\n" +
    messages;
  if (instructions) prompt += `\n\nAdditional instructions: ${instructions}`;
  prompt += "\n\nSummary:";
  return prompt;
}

async function summarizeHistory(
  runtime: IAgentRuntime,
  roomId: UUID,
  instructions?: string,
): Promise<string> {
  // Check for existing compaction point so we only summarise messages since
  // the last compaction, avoiding redundant re-processing.
  const room = await runtime.getRoom(roomId);
  const lastCompactionAt = room?.metadata?.lastCompactionAt as
    | number
    | undefined;

  const messages = await runtime.getMemories({
    tableName: "messages",
    roomId,
    count: 200,
    start: lastCompactionAt,
  });
  if (!messages?.length) return "No conversation history to compact.";

  const sorted = messages.sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );

  let formatted = sorted
    .map((m) => {
      const role = m.entityId === runtime.agentId ? "Assistant" : "User";
      const text = (m.content as Record<string, string>)?.text ?? "";
      return `${role}: ${text}`;
    })
    .join("\n");

  // Truncate to stay within the model's context.
  // Keep the most recent portion so the summary captures the latest state.
  if (formatted.length > MAX_SUMMARY_INPUT_CHARS) {
    formatted = formatted.slice(-MAX_SUMMARY_INPUT_CHARS);
  }

  // Carry forward previous summary for incremental compaction
  let previousSummary = "";
  if (lastCompactionAt) {
    const compactionMsg = sorted.find(
      (m) => m.content?.source === "compaction",
    );
    if (compactionMsg?.content?.text) {
      previousSummary = compactionMsg.content.text;
    }
  }

  return runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildSummaryPrompt(formatted, instructions, previousSummary),
    maxTokens: 2_000,
  });
}

export const compactSessionAction: Action = {
  name: "COMPACT_SESSION",
  similes: ["COMPACT", "COMPRESS", "SUMMARIZE_SESSION"],
  description:
    "Summarize conversation history and set a compaction point. " +
    "Messages before the compaction point will not be included in future context. " +
    "The summary is stored so key decisions and context are preserved.",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (!message.roomId) return false;
    const room = await runtime.getRoom(message.roomId);
    if (!room) return false;
    const messages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      count: 1,
    });
    return (messages?.length ?? 0) > 0;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    const { roomId } = message;
    const msgText =
      ((message.content as Record<string, string>)?.text as string) ?? "";
    const instructions =
      msgText.replace(/^\/?compact\s*/i, "").trim() || undefined;

    try {
      const summary = await summarizeHistory(runtime, roomId, instructions);
      const now = Date.now();

      // Store summary as a message so it appears after the compaction point
      await runtime.createMemory(
        {
          id: crypto.randomUUID() as UUID,
          entityId: runtime.agentId,
          roomId,
          content: {
            text: `[Compaction Summary]\n\n${summary}`,
            source: "compaction",
          },
          createdAt: now,
          metadata: { type: MemoryType.CUSTOM },
        },
        "messages",
      );

      // Set compaction point — recentMessages skips everything before this
      const room = await runtime.getRoom(roomId);
      if (room) {
        const prev = Array.isArray(room.metadata?.compactionHistory)
          ? (room.metadata.compactionHistory as JsonValue[])
          : [];
        const entry: JsonValue = {
          timestamp: now,
          triggeredBy: message.entityId,
        };
        const compactionHistory: JsonValue[] = [...prev, entry].slice(-10);
        await runtime.updateRoom({
          ...room,
          metadata: {
            ...room.metadata,
            lastCompactionAt: now,
            compactionHistory,
          },
        });
      }

      logger.info(
        {
          src: "action:compact-session",
          roomId,
          entityId: message.entityId,
          compactionAt: now,
        },
        "Session compacted with summary",
      );

      if (callback) {
        await callback({
          text: "Session compacted.",
          actions: ["COMPACT_SESSION"],
          source: message.content.source,
        });
      }

      return {
        text: "Session compacted",
        success: true,
        values: { compactedAt: now },
        data: { actionName: "COMPACT_SESSION", compactedAt: now },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { src: "action:compact-session", roomId, error: msg },
        "Compaction failed",
      );

      if (callback) {
        await callback({
          text: `Compaction failed: ${msg}`,
          actions: ["COMPACT_SESSION_FAILED"],
          source: message.content.source,
        });
      }

      return {
        text: `Compaction failed: ${msg}`,
        success: false,
        values: { error: msg },
        data: { actionName: "COMPACT_SESSION" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "/compact" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Session compacted.",
          actions: ["COMPACT_SESSION"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "/compact Focus on decisions" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Session compacted.",
          actions: ["COMPACT_SESSION"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Compress the conversation history" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Session compacted.",
          actions: ["COMPACT_SESSION"],
        },
      },
    ],
  ] as ActionExample[][],
};
