import type { UUID } from "../../types/primitives.ts";

export type ResearchStatus = "open" | "resolved" | "archived";

export interface ResearchFinding {
	query: string;
	summary: string;
	sources?: Array<{ title: string; url: string; snippet?: string }>;
	capturedAt: number;
}

export interface Research {
	id: UUID;
	agentId: UUID;
	userId: UUID;
	title: string;
	status: ResearchStatus;
	findings: ResearchFinding[];
	documentIds?: UUID[];
	createdAt: number;
	updatedAt: number;
}

export interface CreateResearchInput {
	title: string;
	query: string;
}

export interface ContinueResearchInput {
	id: UUID;
	query: string;
}

export interface EditResearchInput {
	title?: string;
	summary?: string;
	status?: ResearchStatus;
}

export interface ListResearchOptions {
	status?: ResearchStatus | "all";
	limit?: number;
}
