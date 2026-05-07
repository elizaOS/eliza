import {
  composePromptFromState,
  type Evaluator,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type TextGenerationModelType,
  type UUID,
} from "@elizaos/core";
import type { MemoryService } from "./memory-service";
import {
  initialSummarizationTemplate,
  longTermExtractionTemplate,
  updateSummarizationTemplate,
} from "./prompts";
import { LongTermMemoryCategory, type MemoryExtraction, type SummaryResult } from "./types";

function isDialogueMessage(message: Memory): boolean {
  return (
    !(
      (message.content?.type as string) === "action_result" &&
      (message.metadata?.type as string) === "action_result"
    ) &&
    ((message.metadata?.type as string) === "agent_response_message" ||
      (message.metadata?.type as string) === "user_message")
  );
}

async function getDialogueMessageCount(runtime: IAgentRuntime, roomId: UUID): Promise<number> {
  const messages = await runtime.getMemories({
    tableName: "messages",
    roomId,
    count: 100,
    unique: false,
  });
  return messages.filter(isDialogueMessage).length;
}

async function countRoomMemories(runtime: IAgentRuntime, roomId: UUID): Promise<number> {
  type ModernCounter = (params: {
    roomIds: UUID[];
    unique: boolean;
    tableName: string;
  }) => Promise<number>;
  type LegacyCounter = (roomId: UUID, unique?: boolean, tableName?: string) => Promise<number>;

  const counter = runtime.countMemories as unknown as ModernCounter | LegacyCounter;
  if (counter.length >= 2) {
    return (counter as LegacyCounter).call(runtime, roomId, false, "messages");
  }
  return (counter as ModernCounter).call(runtime, {
    roomIds: [roomId],
    unique: false,
    tableName: "messages",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (isRecord(value) && "point" in value) {
    return toStringArray(value.point);
  }

  return [];
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;

  try {
    const parsed = JSON.parse(candidate) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return null;
    }

    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function parseSummaryResponse(text: string): SummaryResult {
  const parsed = parseJsonObject(text);
  if (parsed) {
    const summary =
      typeof parsed.text === "string" && parsed.text.trim().length > 0
        ? parsed.text.trim()
        : "Summary not available";
    const topics = toStringArray(parsed.topics);
    const keyPoints = toStringArray(parsed.keyPoints);

    if (summary !== "Summary not available" || topics.length > 0 || keyPoints.length > 0) {
      return { summary, topics, keyPoints };
    }
  }

  const summaryMatch = text.match(/<text>([\s\S]*?)<\/text>/);
  const topicsMatch = text.match(/<topics>([\s\S]*?)<\/topics>/);
  const keyPointsMatches = text.matchAll(/<point>([\s\S]*?)<\/point>/g);

  return {
    summary: summaryMatch ? summaryMatch[1].trim() : "Summary not available",
    topics: topicsMatch
      ? topicsMatch[1]!
          .split(",")
          .map((topic) => topic.trim())
          .filter(Boolean)
      : [],
    keyPoints: Array.from(keyPointsMatches).map((match) => match[1]!.trim()),
  };
}

const validMemoryCategories = new Set(Object.values(LongTermMemoryCategory));

function parseMemoryExtractionResponse(text: string): MemoryExtraction[] {
  const parsed = parseJsonObject(text);
  if (parsed) {
    const rawMemories = parsed.memories;
    const candidateEntries = Array.isArray(rawMemories)
      ? rawMemories
      : isRecord(rawMemories) && "memory" in rawMemories
        ? Array.isArray(rawMemories.memory)
          ? rawMemories.memory
          : [rawMemories.memory]
        : [];

    const memories = candidateEntries
      .filter(isRecord)
      .map((entry) => {
        const category =
          typeof entry.category === "string"
            ? (entry.category.trim() as LongTermMemoryCategory)
            : null;
        const content = typeof entry.content === "string" ? entry.content.trim() : "";
        const confidenceRaw = entry.confidence;
        const confidence =
          typeof confidenceRaw === "number"
            ? confidenceRaw
            : Number.parseFloat(String(confidenceRaw ?? "").trim());

        if (!category || !validMemoryCategories.has(category)) {
          return null;
        }

        if (!content || Number.isNaN(confidence)) {
          return null;
        }

        return { category, content, confidence };
      })
      .filter((entry): entry is MemoryExtraction => entry !== null);

    if (memories.length > 0) {
      return memories;
    }
  }

  const memoryMatches = text.matchAll(
    /<memory>[\s\S]*?<category>(.*?)<\/category>[\s\S]*?<content>(.*?)<\/content>[\s\S]*?<confidence>(.*?)<\/confidence>[\s\S]*?<\/memory>/g,
  );

  const extractions: MemoryExtraction[] = [];
  for (const match of memoryMatches) {
    const category = match[1]!.trim() as LongTermMemoryCategory;
    const content = match[2]!.trim();
    const confidence = Number.parseFloat(match[3]!.trim());

    if (!validMemoryCategories.has(category)) {
      continue;
    }

    if (content && !Number.isNaN(confidence)) {
      extractions.push({ category, content, confidence });
    }
  }

  return extractions;
}

export const summarizationEvaluator: Evaluator = {
  name: "MEMORY_SUMMARIZATION",
  description: "Summarize prior conversation into rolling session context",
  similes: [],
  alwaysRun: true,
  examples: [],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService("memory") as MemoryService | null;
    if (!memoryService?.hasStorage()) {
      return false;
    }

    const config = memoryService.getConfig();
    const currentDialogueCount = await getDialogueMessageCount(runtime, message.roomId);
    const existingSummary = await memoryService.getCurrentSessionSummary(message.roomId);

    if (!existingSummary) {
      return currentDialogueCount >= config.shortTermSummarizationThreshold;
    }

    const newDialogueCount = currentDialogueCount - existingSummary.lastMessageOffset;
    return newDialogueCount >= config.shortTermSummarizationInterval;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const memoryService = runtime.getService("memory") as MemoryService | null;
    if (!memoryService?.hasStorage()) {
      logger.debug({ src: "evaluator:memory" }, "Memory storage not available");
      return undefined;
    }

    const config = memoryService.getConfig();
    const roomId = message.roomId;

    try {
      const existingSummary = await memoryService.getCurrentSessionSummary(roomId);
      const lastOffset = existingSummary?.lastMessageOffset || 0;

      const allMessages = await runtime.getMemories({
        tableName: "messages",
        roomId,
        count: 1000,
        unique: false,
      });
      const allDialogueMessages = allMessages.filter(isDialogueMessage);
      const totalDialogueCount = allDialogueMessages.length;
      const newDialogueCount = totalDialogueCount - lastOffset;

      if (newDialogueCount === 0) {
        return undefined;
      }

      const maxNewMessages = config.summaryMaxNewMessages || 50;
      const messagesToProcess = Math.min(newDialogueCount, maxNewMessages);
      const sortedDialogueMessages = allDialogueMessages.sort(
        (left, right) => (left.createdAt || 0) - (right.createdAt || 0),
      );
      const newDialogueMessages = sortedDialogueMessages.slice(
        lastOffset,
        lastOffset + messagesToProcess,
      );

      if (newDialogueMessages.length === 0) {
        return undefined;
      }

      const formattedMessages = newDialogueMessages
        .map((currentMessage) => {
          const sender =
            currentMessage.entityId === runtime.agentId ? runtime.character.name : "User";
          return `${sender}: ${currentMessage.content.text || "[non-text message]"}`;
        })
        .join("\n");

      const state = await runtime.composeState(message);
      let prompt: string;

      if (existingSummary) {
        prompt = composePromptFromState({
          state: {
            ...state,
            existingSummary: existingSummary.summary,
            existingTopics: existingSummary.topics?.join(", ") || "None",
            newMessages: formattedMessages,
          },
          template: updateSummarizationTemplate,
        });
      } else {
        const initialMessages = sortedDialogueMessages
          .map((currentMessage) => {
            const sender =
              currentMessage.entityId === runtime.agentId ? runtime.character.name : "User";
            return `${sender}: ${currentMessage.content.text || "[non-text message]"}`;
          })
          .join("\n");

        prompt = composePromptFromState({
          state: { ...state, recentMessages: initialMessages },
          template: initialSummarizationTemplate,
        });
      }

      const modelType = (config.summaryModelType ??
        ModelType.TEXT_SMALL) as TextGenerationModelType;
      const response = await runtime.useModel(modelType, {
        prompt,
        maxTokens: config.summaryMaxTokens || 2500,
      });
      const summaryResult = parseSummaryResponse(response);
      const newOffset = lastOffset + newDialogueMessages.length;
      const firstMessage = newDialogueMessages[0];
      const lastMessage = newDialogueMessages[newDialogueMessages.length - 1];

      const startTime = existingSummary
        ? existingSummary.startTime
        : firstMessage?.createdAt && firstMessage.createdAt > 0
          ? new Date(firstMessage.createdAt)
          : new Date();
      const endTime =
        lastMessage?.createdAt && lastMessage.createdAt > 0
          ? new Date(lastMessage.createdAt)
          : new Date();

      if (existingSummary) {
        await memoryService.updateSessionSummary(existingSummary.id, roomId, {
          summary: summaryResult.summary,
          messageCount: existingSummary.messageCount + newDialogueMessages.length,
          lastMessageOffset: newOffset,
          endTime,
          topics: summaryResult.topics,
          metadata: { keyPoints: summaryResult.keyPoints },
        });
      } else {
        await memoryService.storeSessionSummary({
          agentId: runtime.agentId,
          roomId,
          entityId: message.entityId !== runtime.agentId ? message.entityId : undefined,
          summary: summaryResult.summary,
          messageCount: totalDialogueCount,
          lastMessageOffset: totalDialogueCount,
          startTime,
          endTime,
          topics: summaryResult.topics,
          metadata: { keyPoints: summaryResult.keyPoints },
        });
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ src: "evaluator:memory", err }, "Error during summarization");
    }

    return undefined;
  },
};

export const longTermExtractionEvaluator: Evaluator = {
  name: "LONG_TERM_MEMORY_EXTRACTION",
  description: "Extract durable user facts and preferences from conversation",
  similes: [],
  alwaysRun: true,
  examples: [],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (message.entityId === runtime.agentId || !message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService("memory") as MemoryService | null;
    if (!memoryService?.hasStorage()) {
      return false;
    }

    const config = memoryService.getConfig();
    if (!config.longTermExtractionEnabled) {
      return false;
    }

    const currentMessageCount = await countRoomMemories(runtime, message.roomId);
    return memoryService.shouldRunExtraction(message.entityId, message.roomId, currentMessageCount);
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const memoryService = runtime.getService("memory") as MemoryService | null;
    if (!memoryService?.hasStorage()) {
      logger.debug({ src: "evaluator:memory" }, "Memory storage not available");
      return undefined;
    }

    const config = memoryService.getConfig();
    const { entityId, roomId } = message;

    try {
      const recentMessages = await runtime.getMemories({
        tableName: "messages",
        roomId,
        count: 20,
        unique: false,
      });
      const agentName = runtime.character.name ?? "Agent";
      const formattedMessages = recentMessages
        .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
        .map((currentMessage) => {
          const sender = currentMessage.entityId === runtime.agentId ? agentName : "User";
          return `${sender}: ${currentMessage.content.text || "[non-text message]"}`;
        })
        .join("\n");

      const existingMemories = await memoryService.getLongTermMemories(entityId, undefined, 30);
      const formattedExisting =
        existingMemories.length > 0
          ? existingMemories
              .map(
                (memory) =>
                  `[${memory.category}] ${memory.content} (confidence: ${memory.confidence})`,
              )
              .join("\n")
          : "None yet";

      const state = await runtime.composeState(message);
      const prompt = composePromptFromState({
        state: {
          ...state,
          recentMessages: formattedMessages,
          existingMemories: formattedExisting,
        },
        template: longTermExtractionTemplate,
      });

      const modelType = (config.summaryModelType ??
        ModelType.TEXT_SMALL) as TextGenerationModelType;
      const response = await runtime.useModel(modelType, { prompt });
      const extractions = parseMemoryExtractionResponse(response);
      const minConfidence = Math.max(config.longTermConfidenceThreshold, 0.85);
      const extractedAt = new Date().toISOString();

      await Promise.all(
        extractions.map(async (extraction) => {
          if (extraction.confidence < minConfidence) {
            return;
          }

          await memoryService.storeLongTermMemory({
            agentId: runtime.agentId,
            entityId,
            category: extraction.category,
            content: extraction.content,
            confidence: extraction.confidence,
            source: "conversation",
            metadata: {
              roomId,
              extractedAt,
            },
          });
        }),
      );

      const currentMessageCount = await countRoomMemories(runtime, roomId);
      await memoryService.setLastExtractionCheckpoint(entityId, roomId, currentMessageCount);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error({ src: "evaluator:memory", err }, "Error during long-term memory extraction");
    }

    return undefined;
  },
};
