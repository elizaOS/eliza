import { logger } from "../../logger.ts";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "../../types/index.ts";
import { addHeader } from "../../utils.ts";
import type { MemoryService } from "../services/memory-service.ts";

export const longTermMemoryProvider: Provider = {
  name: "LONG_TERM_MEMORY",
  description: "Persistent facts and preferences about the user",
  position: 50,

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    try {
      const memoryService = runtime.getService(
        "memory",
      ) as MemoryService | null;
      if (!memoryService) {
        return {
          data: { memoryCount: 0 },
          values: { longTermMemories: "" },
          text: "",
        };
      }

      const { entityId } = message;
      if (entityId === runtime.agentId) {
        return {
          data: { memoryCount: 0 },
          values: { longTermMemories: "" },
          text: "",
        };
      }

      const memories = await memoryService.getLongTermMemories(
        entityId,
        undefined,
        25,
      );
      if (memories.length === 0) {
        return {
          data: { memoryCount: 0 },
          values: { longTermMemories: "" },
          text: "",
        };
      }

      const formattedMemories =
        await memoryService.getFormattedLongTermMemories(entityId);
      const text = addHeader("# What I Know About You", formattedMemories);

      const categoryCounts = new Map<string, number>();
      for (const memory of memories) {
        const count = categoryCounts.get(memory.category) || 0;
        categoryCounts.set(memory.category, count + 1);
      }

      const categoryList = Array.from(categoryCounts.entries())
        .map(([cat, count]) => `${cat}: ${count}`)
        .join(", ");

      return {
        data: {
          memoryCount: memories.length,
          categories: categoryList,
        },
        values: {
          longTermMemories: text,
          memoryCategories: categoryList,
        },
        text,
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error(
        { src: "provider:memory", err },
        "Error in longTermMemoryProvider",
      );
      return {
        data: { memoryCount: 0 },
        values: { longTermMemories: "" },
        text: "",
      };
    }
  },
};
