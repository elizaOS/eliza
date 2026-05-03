import type { Memory } from "../../../types/memory.ts";
import type { UUID } from "../../../types/primitives.ts";
import type { ServiceTypeRegistry } from "../../../types/service.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

declare module "../../../types/service.ts" {
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

export type ExperienceGraphLinkType =
	| "similar"
	| "supports"
	| "contradicts"
	| "supersedes"
	| "co_occurs";

export interface ExperienceGraphNode {
	id: UUID;
	label: string;
	type: ExperienceType;
	outcome: OutcomeType;
	domain: string;
	keywords: string[];
	associatedEntityIds: UUID[];
	confidence: number;
	importance: number;
	timeWeight: number;
	x: number;
	y: number;
}

export interface ExperienceGraphLink {
	sourceId: UUID;
	targetId: UUID;
	type: ExperienceGraphLinkType;
	strength: number;
	reason: string;
	keywords: string[];
}

export interface ExperienceGraphSnapshot {
	generatedAt: number;
	totalExperiences: number;
	nodes: ExperienceGraphNode[];
	links: ExperienceGraphLink[];
}

export interface ExperienceConsolidationGroup {
	primaryId: UUID;
	duplicateIds: UUID[];
	mergedKeywords: string[];
	reason: string;
}

export interface ExperienceConsolidationResult {
	inspected: number;
	groups: ExperienceConsolidationGroup[];
	merged: number;
	deleted: number;
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
	keywords: string[]; // Searchable concepts extracted from context/action/result/learning
	associatedEntityIds: UUID[]; // People/entities recently present when the lesson formed

	// Related experiences
	relatedExperiences?: UUID[]; // Links to related experiences
	supersedes?: UUID; // If this experience updates/replaces another
	mergedExperienceIds?: UUID[]; // Historical duplicate IDs folded into this record

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

	// Provenance for review and evidence replay
	sourceMessageIds?: UUID[]; // Conversation messages used as extraction evidence
	sourceRoomId?: UUID; // Room where the evidence was observed
	sourceTriggerMessageId?: UUID; // Agent message that triggered extraction
	sourceTrajectoryId?: string; // Full trajectory, when available
	sourceTrajectoryStepId?: string; // Active trajectory step, when available
	extractionMethod?: string; // e.g. experience_evaluator or record_experience_action
	extractionReason?: string; // LLM/self-reflection rationale for the memory
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
