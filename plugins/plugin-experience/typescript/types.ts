import type { Memory, ServiceTypeRegistry, UUID } from "@elizaos/core";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// Extend the core service types with experience service
declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    EXPERIENCE: "EXPERIENCE";
  }
}

// Export service type constant
export const ExperienceServiceType = {
  EXPERIENCE: "EXPERIENCE" as const,
} satisfies Partial<ServiceTypeRegistry>;

export enum ExperienceType {
  SUCCESS = "success", // Agent accomplished something
  FAILURE = "failure", // Agent failed at something
  DISCOVERY = "discovery", // Agent discovered new information
  CORRECTION = "correction", // Agent corrected a mistake
  LEARNING = "learning", // Agent learned something new
  HYPOTHESIS = "hypothesis", // Agent formed a hypothesis
  VALIDATION = "validation", // Agent validated a hypothesis
  WARNING = "warning", // Agent encountered a warning/limitation
}

export enum OutcomeType {
  POSITIVE = "positive",
  NEGATIVE = "negative",
  NEUTRAL = "neutral",
  MIXED = "mixed",
}

export interface Experience {
  id: UUID;
  agentId: UUID;
  type: ExperienceType;
  outcome: OutcomeType;

  // Context and details
  context: string; // What was happening
  action: string; // What the agent tried to do
  result: string; // What actually happened
  learning: string; // What was learned

  // Categorization
  tags: string[]; // Tags for categorization
  domain: string; // Domain of experience (e.g., 'shell', 'coding', 'system')

  // Related experiences
  relatedExperiences?: UUID[]; // Links to related experiences
  supersedes?: UUID; // If this experience updates/replaces another

  // Confidence and importance
  confidence: number; // 0-1, how confident the agent is in this learning
  importance: number; // 0-1, how important this experience is

  // Temporal information
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  accessCount: number;

  // For corrections
  previousBelief?: string; // What the agent previously believed
  correctedBelief?: string; // The corrected understanding

  // Memory integration
  embedding?: number[]; // For semantic search
  memoryIds?: UUID[]; // Related memory IDs
}

export interface ExperienceQuery {
  query?: string; // Text query for semantic search
  type?: ExperienceType | ExperienceType[];
  outcome?: OutcomeType | OutcomeType[];
  domain?: string | string[];
  tags?: string[];
  minImportance?: number;
  minConfidence?: number;
  timeRange?: {
    start?: number;
    end?: number;
  };
  limit?: number;
  includeRelated?: boolean;
}

export interface ExperienceAnalysis {
  pattern?: string; // Detected pattern
  frequency?: number; // How often this occurs
  reliability?: number; // How reliable this knowledge is
  alternatives?: string[]; // Alternative approaches discovered
  recommendations?: string[]; // Recommendations based on experience
}

export interface ExperienceEvent {
  experienceId: UUID;
  eventType: "created" | "accessed" | "updated" | "superseded";
  timestamp: number;
  metadata?: JsonObject;
}

export interface ExperienceMemory extends Memory {
  experienceId: string;
  experienceType: ExperienceType;
}
