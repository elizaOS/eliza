import type { UUID } from "@elizaos/core";

export enum LongTermMemoryCategory {
  EPISODIC = "episodic",
  SEMANTIC = "semantic",
  PROCEDURAL = "procedural",
}

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

export interface MemoryConfig {
  shortTermSummarizationThreshold: number;
  shortTermRetainRecent: number;
  shortTermSummarizationInterval: number;
  longTermExtractionEnabled: boolean;
  longTermVectorSearchEnabled: boolean;
  longTermConfidenceThreshold: number;
  longTermExtractionThreshold: number;
  longTermExtractionInterval: number;
  summaryModelType?: string;
  summaryMaxTokens?: number;
  summaryMaxNewMessages?: number;
}

export interface MemoryExtraction {
  category: LongTermMemoryCategory;
  content: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface SummaryResult {
  summary: string;
  topics: string[];
  keyPoints: string[];
}

export type MemoryServiceTypeName = "memory";
