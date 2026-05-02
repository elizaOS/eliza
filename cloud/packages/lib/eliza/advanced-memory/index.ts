import type { Plugin } from "@elizaos/core";
import { longTermExtractionEvaluator, summarizationEvaluator } from "./evaluators";
import { MemoryService } from "./memory-service";
import { contextSummaryProvider, longTermMemoryProvider } from "./providers";

export {
  longTermExtractionEvaluator,
  summarizationEvaluator,
} from "./evaluators";
export { MemoryService } from "./memory-service";
export {
  contextSummaryProvider,
  longTermMemoryProvider,
} from "./providers";
export * from "./types";

export function createAdvancedMemoryPlugin(): Plugin {
  return {
    name: "memory",
    description:
      "Memory management with conversation summarization and long-term persistent memory",
    services: [MemoryService],
    evaluators: [summarizationEvaluator, longTermExtractionEvaluator],
    providers: [longTermMemoryProvider, contextSummaryProvider],
  };
}
