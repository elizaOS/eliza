import type { UUID } from '@elizaos/core';

/**
 * Categories of long-term memory based on cognitive science
 * 
 * Following the widely accepted classification of human long-term memory:
 * - EPISODIC: Personal experiences and events (what happened, when, where)
 * - SEMANTIC: Facts, concepts, and knowledge (what things mean)
 * - PROCEDURAL: Skills and how-to knowledge (how to do things)
 */
export enum LongTermMemoryCategory {
  EPISODIC = 'episodic', // Specific events, experiences, and interactions (e.g., "User worked on bug #123 last Tuesday")
  SEMANTIC = 'semantic', // General facts, concepts, and knowledge (e.g., "User is a Python developer", "User prefers async/await")
  PROCEDURAL = 'procedural', // Skills, workflows, and how-to knowledge (e.g., "User follows TDD workflow", "User uses git rebase instead of merge")
}

/**
 * Long-term memory entry
 */
export interface LongTermMemory {
  id: UUID;
  agentId: UUID;
  entityId: UUID; // The user/entity this memory is about
  category: LongTermMemoryCategory;
  content: string; // The actual memory content
  metadata?: Record<string, unknown>; // Additional structured data
  embedding?: number[]; // Vector embedding for semantic search
  confidence?: number; // Confidence score (0-1)
  source?: string; // Where this memory came from (conversation, manual, etc.)
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date;
  accessCount?: number;
  similarity?: number; // Optional similarity score from vector search
}

/**
 * Short-term memory session summary
 */
export interface SessionSummary {
  id: UUID;
  agentId: UUID;
  roomId: UUID;
  entityId?: UUID; // Optional: specific user in the session
  summary: string; // The summarized conversation
  messageCount: number; // Number of messages summarized
  lastMessageOffset: number; // Index of last summarized message (for pagination)
  startTime: Date; // Timestamp of first message
  endTime: Date; // Timestamp of last message
  topics?: string[]; // Main topics discussed
  metadata?: Record<string, unknown>;
  embedding?: number[]; // Vector embedding of the summary
  createdAt: Date;
  updatedAt: Date; // Track when summary was last updated
}

/**
 * Configuration for memory plugin
 */
export interface MemoryConfig {
  // Short-term memory settings
  shortTermSummarizationThreshold: number; // Messages count before summarization
  shortTermRetainRecent: number; // Number of recent messages to keep after summarization
  shortTermSummarizationInterval: number; // Update summary every N messages after threshold (e.g., 10)

  // Long-term memory settings
  longTermExtractionEnabled: boolean;
  longTermVectorSearchEnabled: boolean;
  longTermConfidenceThreshold: number; // Minimum confidence to store
  longTermExtractionThreshold: number; // Minimum messages before starting extraction (default 20)
  longTermExtractionInterval: number; // Run extraction every N messages after threshold (e.g., 5, 10, 15...)

  // Summarization settings
  summaryModelType?: string;
  summaryMaxTokens?: number;
  summaryMaxNewMessages?: number; // Max new messages to include in update (prevents context bloat)
}

/**
 * Memory extraction result from evaluator
 */
export interface MemoryExtraction {
  category: LongTermMemoryCategory;
  content: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

/**
 * Summary generation result
 */
export interface SummaryResult {
  summary: string;
  topics: string[];
  keyPoints: string[];
}
