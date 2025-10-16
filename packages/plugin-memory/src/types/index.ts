import type { UUID } from '@elizaos/core';

/**
 * Categories of long-term memory
 */
export enum LongTermMemoryCategory {
  IDENTITY = 'identity', // User identity, name, roles
  EXPERTISE = 'expertise', // Domain knowledge and familiarity
  PROJECTS = 'projects', // Past interactions and recurring topics
  PREFERENCES = 'preferences', // User preferences for interaction style
  DATA_SOURCES = 'data_sources', // Frequently used files, databases, APIs
  GOALS = 'goals', // User's broader intentions and objectives
  CONSTRAINTS = 'constraints', // User-defined rules and limitations
  DEFINITIONS = 'definitions', // Custom terms, acronyms, glossaries
  BEHAVIORAL_PATTERNS = 'behavioral_patterns', // User interaction patterns
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
  startTime: Date; // Timestamp of first message
  endTime: Date; // Timestamp of last message
  topics?: string[]; // Main topics discussed
  metadata?: Record<string, unknown>;
  embedding?: number[]; // Vector embedding of the summary
  createdAt: Date;
}

/**
 * Configuration for memory plugin
 */
export interface MemoryConfig {
  // Short-term memory settings
  shortTermSummarizationThreshold: number; // Messages count before summarization
  shortTermRetainRecent: number; // Number of recent messages to keep after summarization

  // Long-term memory settings
  longTermExtractionEnabled: boolean;
  longTermVectorSearchEnabled: boolean;
  longTermConfidenceThreshold: number; // Minimum confidence to store

  // Summarization settings
  summaryModelType?: string;
  summaryMaxTokens?: number;
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
