import type { Plugin } from "@elizaos/core";
import { longTermExtractionEvaluator, summarizationEvaluator } from "./evaluators";
import { contextSummaryProvider, longTermMemoryProvider } from "./providers";
import * as schema from "./schemas";
import { MemoryService } from "./services/memory-service";

export {
  longTermExtractionEvaluator,
  summarizationEvaluator,
} from "./evaluators";
export { contextSummaryProvider, longTermMemoryProvider } from "./providers";
export * from "./schemas";
export { MemoryService } from "./services/memory-service";
export * from "./types";

export const memoryPlugin: Plugin = {
  name: "memory",
  description: "Memory management with conversation summarization and long-term persistent memory",

  services: [MemoryService],

  evaluators: [summarizationEvaluator, longTermExtractionEvaluator],

  providers: [longTermMemoryProvider, contextSummaryProvider],

  schema,
};

export default memoryPlugin;
