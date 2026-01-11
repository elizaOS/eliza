/**
 * Types for the Memory Plugin
 *
 * Categories of long-term memory based on cognitive science
 */

import type { UUID } from "@elizaos/core";

/**
 * Categories of long-term memory based on cognitive science
 *
 * Following the widely accepted classification of human long-term memory:
 * - EPISODIC: Personal experiences and events (what happened, when, where)
 * - SEMANTIC: Facts, concepts, and knowledge (what things mean)
 * - PROCEDURAL: Skills and how-to knowledge (how to do things)
 */
export enum LongTermMemoryCategory {
  EPISODIC = "episodic", // Specific events, experiences, and interactions
  SEMANTIC = "semantic", // General facts, concepts, and knowledge
  PROCEDURAL = "procedural", // Skills, workflows, and how-to knowledge
}

/**
 * Long-term memory entry
 */
export interface LongTermMemory {
  id: UUID;
  agentId: UUID;
  entityId: UUID;
  category: LongTermMemoryCategory;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  confidence?: number;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date;
  accessCount?: number;
  similarity?: number;
}

/**
 * Short-term memory session summary
 */
export interface SessionSummary {
  id: UUID;
  agentId: UUID;
  roomId: UUID;
  entityId?: UUID;
  summary: string;
  messageCount: number;
  lastMessageOffset: number;
  startTime: Date;
  endTime: Date;
  topics?: string[];
  metadata?: Record<string, unknown>;
  embedding?: number[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Configuration for memory plugin
 */
export interface MemoryConfig {
  // Short-term memory settings
  shortTermSummarizationThreshold: number;
  shortTermRetainRecent: number;
  shortTermSummarizationInterval: number;

  // Long-term memory settings
  longTermExtractionEnabled: boolean;
  longTermVectorSearchEnabled: boolean;
  longTermConfidenceThreshold: number;
  longTermExtractionThreshold: number;
  longTermExtractionInterval: number;

  // Summarization settings
  summaryModelType?: string;
  summaryMaxTokens?: number;
  summaryMaxNewMessages?: number;
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

/**
 * Service type name for registration
 */
export type MemoryServiceTypeName = "memory";
