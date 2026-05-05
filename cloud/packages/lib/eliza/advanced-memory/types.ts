import type { TextGenerationModelType, UUID } from "@elizaos/core";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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
  metadata?: Record<string, JsonValue>;
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
  metadata?: Record<string, JsonValue>;
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
  summaryModelType?: TextGenerationModelType;
  summaryMaxTokens?: number;
  summaryMaxNewMessages?: number;
}

export interface MemoryExtraction {
  category: LongTermMemoryCategory;
  content: string;
  confidence: number;
  metadata?: Record<string, JsonValue>;
}

export interface SummaryResult {
  summary: string;
  topics: string[];
  keyPoints: string[];
}

export interface MemoryStorageProvider {
  storeLongTermMemory(
    memory: Omit<LongTermMemory, "id" | "createdAt" | "updatedAt" | "accessCount">,
  ): Promise<LongTermMemory>;

  getLongTermMemories(
    agentId: UUID,
    entityId: UUID,
    opts?: { category?: LongTermMemoryCategory; limit?: number },
  ): Promise<LongTermMemory[]>;

  updateLongTermMemory(
    id: UUID,
    agentId: UUID,
    entityId: UUID,
    updates: Partial<Omit<LongTermMemory, "id" | "agentId" | "entityId" | "createdAt">>,
  ): Promise<void>;

  deleteLongTermMemory(id: UUID, agentId: UUID, entityId: UUID): Promise<void>;

  storeSessionSummary(
    summary: Omit<SessionSummary, "id" | "createdAt" | "updatedAt">,
  ): Promise<SessionSummary>;

  getCurrentSessionSummary(agentId: UUID, roomId: UUID): Promise<SessionSummary | null>;

  updateSessionSummary(
    id: UUID,
    agentId: UUID,
    roomId: UUID,
    updates: Partial<Omit<SessionSummary, "id" | "agentId" | "roomId" | "createdAt" | "updatedAt">>,
  ): Promise<void>;

  getSessionSummaries(agentId: UUID, roomId: UUID, limit?: number): Promise<SessionSummary[]>;
}
