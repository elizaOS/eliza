import type {
  Action,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { isSyntheticConversationArtifactMemory } from "@elizaos/core";
import {
  compactors,
  findSafeCompactionBoundary,
} from "../runtime/conversation-compactor.ts";
import type {
  CompactorMessage,
  CompactorModelCall,
} from "../runtime/conversation-compactor.types.ts";
import {
  approxCountTokens,
  countTranscriptTokens,
} from "../runtime/conversation-compactor.types.ts";
import {
  getConversationCompactionLedger,
  type StrategyName,
  setConversationCompactionLedger,
} from "../runtime/conversation-compactor-runtime.ts";

const DEFAULT_TARGET_TOKENS = 1200;
const DEFAULT_PRESERVE_TAIL = 8;
const MIN_COMPACTABLE_MESSAGES = 6;
const MAX_MESSAGES_TO_READ = 5000;
const MESSAGE_FETCH_PAGE_SIZE = 250;
const STRATEGY: StrategyName = "hybrid-ledger";

type CompactParams = {
  targetTokens?: number;
  preserveTailMessages?: number;
};

function getText(memory: Memory): string {
  return typeof memory.content?.text === "string" ? memory.content.text : "";
}

function memoryToCompactorMessage(
  runtime: IAgentRuntime,
  memory: Memory,
): CompactorMessage | null {
  const content = getText(memory).trim();
  if (!content) return null;
  return {
    role: memory.entityId === runtime.agentId ? "assistant" : "user",
    content,
    ...(memory.createdAt ? { timestamp: memory.createdAt } : {}),
  };
}

function buildActionCompactorModelCall(
  runtime: IAgentRuntime,
): CompactorModelCall {
  return async ({ systemPrompt, messages, maxOutputTokens }) => {
    const result = await runtime.useModel("TEXT_LARGE", {
      system: systemPrompt,
      prompt: messages.map((m) => m.content).join("\n"),
      ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
    });
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const record = result as Record<string, unknown>;
      for (const key of ["text", "content", "reasoning", "message"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value;
        }
      }
    }
    return result == null ? "" : JSON.stringify(result);
  };
}

async function countRoomMessages(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<number> {
  try {
    return await runtime.countMemories({
      roomIds: [message.roomId],
      tableName: "messages",
      unique: false,
    });
  } catch {
    return 0;
  }
}

async function getCompactableMessages(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<Memory[]> {
  const total = await countRoomMessages(runtime, message);
  const limit = Math.max(
    MESSAGE_FETCH_PAGE_SIZE,
    Math.min(total || MAX_MESSAGES_TO_READ, MAX_MESSAGES_TO_READ),
  );
  const memories: Memory[] = [];
  for (let offset = 0; offset < limit; offset += MESSAGE_FETCH_PAGE_SIZE) {
    const page = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      limit: Math.min(MESSAGE_FETCH_PAGE_SIZE, limit - offset),
      offset,
      unique: false,
      orderBy: "createdAt",
      orderDirection: "asc",
    });
    if (page.length === 0) break;
    memories.push(...page);
    if (page.length < MESSAGE_FETCH_PAGE_SIZE) break;
  }
  return memories
    .filter(
      (memory) =>
        getText(memory).trim().length > 0 &&
        !isSyntheticConversationArtifactMemory(memory),
    )
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export const compactConversationAction: Action = {
  name: "COMPACT_CONVERSATION",
  contexts: ["general", "memory", "messaging", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "COMPACT_HISTORY",
    "SUMMARIZE_CONVERSATION_MEMORY",
    "ROLL_UP_CONVERSATION",
    "COMPRESS_CONVERSATION",
  ],
  description:
    "Compact the current existing conversation into a persisted hybrid ledger and prune old raw turns from future prompt context. Use only when the user explicitly asks to compact this session/history.",
  descriptionCompressed:
    "owner-only manual conversation compaction for existing sessions",
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => {
    if (!message.roomId) return false;
    const count = await countRoomMessages(runtime, message);
    return count >= MIN_COMPACTABLE_MESSAGES;
  },
  handler: async (runtime, message, _state, options): Promise<ActionResult> => {
    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | CompactParams
        | undefined) ?? {};
    const targetTokens = Math.max(
      256,
      Math.min(4096, Number(params.targetTokens) || DEFAULT_TARGET_TOKENS),
    );
    const preserveTailMessages = Math.max(
      2,
      Math.min(
        24,
        Number(params.preserveTailMessages) || DEFAULT_PRESERVE_TAIL,
      ),
    );
    const memories = await getCompactableMessages(runtime, message);
    if (memories.length < MIN_COMPACTABLE_MESSAGES) {
      return {
        success: false,
        text: "There is not enough prior conversation to compact yet.",
        values: { compacted: false, reason: "new-session" },
        data: { actionName: "COMPACT_CONVERSATION", reason: "new-session" },
      };
    }

    const messages = memories
      .map((memory) => memoryToCompactorMessage(runtime, memory))
      .filter((entry): entry is CompactorMessage => entry !== null);
    const boundary = findSafeCompactionBoundary(messages, preserveTailMessages);
    if (boundary <= 0) {
      return {
        success: false,
        text: "Only the recent tail is available, so there is nothing safe to compact.",
        values: { compacted: false, reason: "tail-only" },
        data: { actionName: "COMPACT_CONVERSATION", reason: "tail-only" },
      };
    }

    const priorLedger = await getConversationCompactionLedger(
      runtime as never,
      String(message.roomId),
    );
    const artifact = await compactors[STRATEGY].compact(
      {
        messages,
        metadata: {
          conversationKey: String(message.roomId),
          ...(priorLedger ? { priorLedger } : {}),
        },
      },
      {
        targetTokens,
        preserveTailMessages,
        callModel: buildActionCompactorModelCall(runtime),
        countTokens: approxCountTokens,
      },
    );
    const renderedLedger = artifact.stats.extra?.renderedLedger;
    if (
      typeof renderedLedger !== "string" ||
      renderedLedger.trim().length === 0
    ) {
      return {
        success: false,
        text: "Compaction did not produce a usable ledger.",
        values: { compacted: false, reason: "empty-ledger" },
        data: { actionName: "COMPACT_CONVERSATION", reason: "empty-ledger" },
      };
    }

    const compactedThrough =
      memories[Math.min(boundary - 1, memories.length - 1)];
    const lastCompactionAt = (compactedThrough?.createdAt ?? Date.now()) + 1;
    const totalRoomMessages = await countRoomMessages(runtime, message);
    await setConversationCompactionLedger(
      runtime as never,
      String(message.roomId),
      renderedLedger,
      {
        strategy: STRATEGY,
        source: "manual-action",
        lastCompactionAt,
        historyEntry: {
          at: new Date().toISOString(),
          strategy: STRATEGY,
          compactedMessageCount: boundary,
          preservedTailMessages: messages.length - boundary,
          loadedMessageCount: messages.length,
          completeMessageWindow: memories.length >= totalRoomMessages,
          originalTokens: countTranscriptTokens(
            { messages },
            approxCountTokens,
          ),
          compactedTokens: artifact.stats.compactedTokens,
        },
      },
    );

    return {
      success: true,
      text: `Compacted ${boundary} older message(s); preserved the latest ${messages.length - boundary}.`,
      values: {
        compacted: true,
        compactedMessageCount: boundary,
        preservedTailMessages: messages.length - boundary,
      },
      data: {
        actionName: "COMPACT_CONVERSATION",
        strategy: STRATEGY,
        roomId: message.roomId,
        lastCompactionAt,
        stats: artifact.stats,
      },
    };
  },
  parameters: [
    {
      name: "targetTokens",
      description:
        "Optional compact ledger target token budget. Defaults to 1200.",
      required: false,
      schema: { type: "number" as const, minimum: 256, maximum: 4096 },
    },
    {
      name: "preserveTailMessages",
      description:
        "Optional number of newest messages to keep verbatim. Defaults to 8.",
      required: false,
      schema: { type: "number" as const, minimum: 2, maximum: 24 },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Compact this conversation history now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Compacted older messages and kept the latest turns.",
          action: "COMPACT_CONVERSATION",
        },
      },
    ],
  ],
};
