import { requireEvaluatorSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import {
  type EvaluationExample,
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  ModelType,
} from "../../types/index.ts";
import { composePromptFromState } from "../../utils.ts";
import { longTermExtractionTemplate } from "../prompts.ts";
import type { MemoryService } from "../services/memory-service.ts";
import { LongTermMemoryCategory, type MemoryExtraction } from "../types.ts";

const spec = requireEvaluatorSpec("LONG_TERM_MEMORY_EXTRACTION");
const validMemoryCategories = new Set(Object.values(LongTermMemoryCategory));

function parseMemoryExtractionXML(xml: string): MemoryExtraction[] {
  const memoryMatches = xml.matchAll(
    /<memory>[\s\S]*?<category>(.*?)<\/category>[\s\S]*?<content>(.*?)<\/content>[\s\S]*?<confidence>(.*?)<\/confidence>[\s\S]*?<\/memory>/g,
  );

  const extractions: MemoryExtraction[] = [];

  for (const match of memoryMatches) {
    const category = match[1].trim() as LongTermMemoryCategory;
    const content = match[2].trim();
    const confidence = Number.parseFloat(match[3].trim());

    if (!validMemoryCategories.has(category)) {
      logger.warn(
        { src: "evaluator:memory" },
        `Invalid memory category: ${category}`,
      );
      continue;
    }

    if (content && !Number.isNaN(confidence)) {
      extractions.push({ category, content, confidence });
    }
  }

  return extractions;
}

export const longTermExtractionEvaluator: Evaluator = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes ? [...spec.similes] : [],
  alwaysRun: spec.alwaysRun ?? true,
  examples: (spec.examples ?? []) as EvaluationExample[],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    if (message.entityId === runtime.agentId) return false;
    if (!message.content?.text) return false;

    const memoryService = runtime.getService("memory") as MemoryService | null;
    if (!memoryService) return false;

    const config = memoryService.getConfig();
    if (!config.longTermExtractionEnabled) {
      logger.debug(
        { src: "evaluator:memory" },
        "Long-term memory extraction is disabled",
      );
      return false;
    }

    const currentMessageCount = await runtime.countMemories(
      message.roomId,
      false,
      "messages",
    );
    return memoryService.shouldRunExtraction(
      message.entityId,
      message.roomId,
      currentMessageCount,
    );
  },

  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const memoryService = runtime.getService("memory") as MemoryService;
    if (!memoryService) {
      logger.error({ src: "evaluator:memory" }, "MemoryService not found");
      return undefined;
    }

    const config = memoryService.getConfig();
    const { entityId, roomId } = message;

    try {
      logger.info(
        { src: "evaluator:memory" },
        `Extracting long-term memories for entity ${entityId}`,
      );

      const recentMessages = await runtime.getMemories({
        tableName: "messages",
        roomId,
        count: 20,
        unique: false,
      });

      const agentName = runtime.character.name ?? "Agent";
      const formattedMessages = recentMessages
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map((msg) => {
          const sender = msg.entityId === runtime.agentId ? agentName : "User";
          return `${sender}: ${msg.content.text || "[non-text message]"}`;
        })
        .join("\n");

      const existingMemories = await memoryService.getLongTermMemories(
        entityId,
        undefined,
        30,
      );
      let formattedExisting = "None yet";
      if (existingMemories.length > 0) {
        const lines: string[] = [];
        for (const memory of existingMemories) {
          lines.push(
            `[${memory.category}] ${memory.content} (confidence: ${memory.confidence})`,
          );
        }
        formattedExisting = lines.join("\n");
      }

      const state = await runtime.composeState(message);
      const prompt = composePromptFromState({
        state: {
          ...state,
          recentMessages: formattedMessages,
          existingMemories: formattedExisting,
        },
        template: longTermExtractionTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      const extractions = parseMemoryExtractionXML(response);

      logger.info(
        { src: "evaluator:memory" },
        `Extracted ${extractions.length} long-term memories`,
      );

      const minConfidence = Math.max(config.longTermConfidenceThreshold, 0.85);
      const extractedAt = new Date().toISOString();
      await Promise.all(
        extractions.map(async (extraction) => {
          if (extraction.confidence >= minConfidence) {
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

            logger.info(
              { src: "evaluator:memory" },
              `Stored long-term memory: [${extraction.category}] ${extraction.content.substring(0, 50)}...`,
            );
          } else {
            logger.debug(
              { src: "evaluator:memory" },
              `Skipped low-confidence memory: ${extraction.content} (confidence: ${extraction.confidence})`,
            );
          }
        }),
      );

      const currentMessageCount = await runtime.countMemories(
        roomId,
        false,
        "messages",
      );
      await memoryService.setLastExtractionCheckpoint(
        entityId,
        roomId,
        currentMessageCount,
      );
      logger.debug(
        { src: "evaluator:memory" },
        `Updated checkpoint to ${currentMessageCount} for entity ${entityId}`,
      );
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(
        { src: "evaluator:memory", err },
        "Error during long-term memory extraction",
      );
    }
    return undefined;
  },
};
