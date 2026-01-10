import type { Plugin } from '@elizaos/core';
import { MemoryService } from './services/memory-service';
import { summarizationEvaluator, longTermExtractionEvaluator } from './evaluators';
import { longTermMemoryProvider, contextSummaryProvider } from './providers';
import * as schema from './schemas';

// Re-exports
export * from './types';
export * from './schemas';
export { MemoryService } from './services/memory-service';
export { contextSummaryProvider, longTermMemoryProvider } from './providers';
export { summarizationEvaluator, longTermExtractionEvaluator } from './evaluators';

/**
 * Memory Plugin
 *
 * Advanced memory management plugin that provides:
 *
 * **Short-term Memory (Conversation Summarization)**:
 * - Automatically summarizes long conversations to reduce context size
 * - Retains recent messages while archiving older ones as summaries
 * - Configurable thresholds for when to summarize
 *
 * **Long-term Memory (Persistent Facts)**:
 * - Extracts and stores persistent facts about users
 * - Categorizes information (episodic, semantic, procedural)
 * - Provides context-aware user profiles across all conversations
 *
 * **Components**:
 * - `MemoryService`: Manages all memory operations
 * - Evaluators: Process conversations to create summaries and extract facts
 * - Providers: Inject memory context into conversations
 *
 * **Configuration** (via environment variables):
 * - `MEMORY_SUMMARIZATION_THRESHOLD`: Messages before summarization (default: 16)
 * - `MEMORY_RETAIN_RECENT`: Recent messages to keep (default: 6)
 * - `MEMORY_LONG_TERM_ENABLED`: Enable long-term extraction (default: true)
 * - `MEMORY_CONFIDENCE_THRESHOLD`: Minimum confidence to store (default: 0.85)
 *
 * **Database Tables**:
 * - `long_term_memories`: Persistent user facts
 * - `session_summaries`: Conversation summaries
 * - `memory_access_logs`: Optional usage tracking
 */
export const memoryPlugin: Plugin = {
  name: 'memory',
  description:
    'Advanced memory management with conversation summarization and long-term persistent memory',

  services: [MemoryService],

  evaluators: [summarizationEvaluator, longTermExtractionEvaluator],

  providers: [longTermMemoryProvider, contextSummaryProvider],

  schema,
};

export default memoryPlugin;

