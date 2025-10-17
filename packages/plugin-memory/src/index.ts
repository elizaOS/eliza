import type { Plugin } from '@elizaos/core';
import { MemoryService } from './services/memory-service';
import { summarizationEvaluator } from './evaluators/summarization';
import { longTermExtractionEvaluator } from './evaluators/long-term-extraction';
import { shortTermMemoryProvider } from './providers/short-term-memory';
import { longTermMemoryProvider } from './providers/long-term-memory';
// import { rememberAction } from './actions/remember';
import * as schema from './schemas/index';

export * from './types/index';
export * from './schemas/index';
export { MemoryService } from './services/memory-service';

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
 * - Categorizes information (identity, expertise, preferences, etc.)
 * - Provides context-aware user profiles across all conversations
 *
 * **Components**:
 * - `MemoryService`: Manages all memory operations
 * - Evaluators: Process conversations to create summaries and extract facts
 * - Providers: Inject memory context into conversations
 * - Actions: Allow manual memory storage via user commands
 *
 * **Configuration** (via environment variables):
 * - `MEMORY_SUMMARIZATION_THRESHOLD`: Messages before summarization (default: 50)
 * - `MEMORY_RETAIN_RECENT`: Recent messages to keep (default: 10)
 * - `MEMORY_LONG_TERM_ENABLED`: Enable long-term extraction (default: true)
 * - `MEMORY_CONFIDENCE_THRESHOLD`: Minimum confidence to store (default: 0.7)
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

  providers: [longTermMemoryProvider, shortTermMemoryProvider],

  // actions: [rememberAction],

  // Export schema for dynamic migrations
  schema,
};

export default memoryPlugin;
