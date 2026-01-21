import type { Plugin } from "../types/index.ts";
import {
  longTermExtractionEvaluator,
  summarizationEvaluator,
} from "./evaluators/index.ts";
import {
  contextSummaryProvider,
  longTermMemoryProvider,
} from "./providers/index.ts";
import * as schema from "./schemas/index.ts";
import { MemoryService } from "./services/memory-service.ts";

export {
  longTermExtractionEvaluator,
  summarizationEvaluator,
} from "./evaluators/index.ts";
export {
  contextSummaryProvider,
  longTermMemoryProvider,
} from "./providers/index.ts";
export * from "./schemas/index.ts";
export { MemoryService } from "./services/memory-service.ts";
export * from "./types.ts";

export function createAdvancedMemoryPlugin(): Plugin {
  return {
    name: "memory",
    description:
      "Memory management with conversation summarization and long-term persistent memory",
    services: [MemoryService],
    evaluators: [summarizationEvaluator, longTermExtractionEvaluator],
    providers: [longTermMemoryProvider, contextSummaryProvider],
    schema,
  };
}
