import type { IAgentRuntime } from "../../../types/index.ts";

export interface SkillTrajectoryLlmCall {
	systemPrompt?: string;
	userPrompt?: string;
	response?: string;
	actionType?: string;
	purpose?: string;
}

export interface SkillTrajectoryStep {
	stepId?: string;
	timestamp: number;
	llmCalls?: SkillTrajectoryLlmCall[];
	usedSkills?: string[];
}

export interface SkillTrajectory {
	trajectoryId: string;
	agentId: string;
	startTime: number;
	endTime?: number;
	steps?: SkillTrajectoryStep[];
	metrics?: { finalStatus?: string };
	metadata?: Record<string, unknown>;
}

export interface SkillTrajectoryListItem {
	id: string;
	status: string;
	stepCount?: number;
	endTime: number | null;
	metadata?: Record<string, unknown>;
}

export interface SkillTrajectoryService {
	listTrajectories?: (options: {
		limit?: number;
		status?: string;
	}) => Promise<{ trajectories: SkillTrajectoryListItem[] }>;
	getTrajectoryDetail?: (
		trajectoryId: string,
	) => Promise<SkillTrajectory | null>;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
	const jsonText = raw.trim();
	if (!jsonText) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	return parsed as Record<string, unknown>;
}

export function getTrajectoryService(
	runtime: IAgentRuntime,
): SkillTrajectoryService | null {
	const svc = runtime.getService("trajectories");
	if (!svc) return null;
	const shape = svc as SkillTrajectoryService;
	if (
		typeof shape.listTrajectories !== "function" ||
		typeof shape.getTrajectoryDetail !== "function"
	) {
		return null;
	}
	return shape;
}

export function formatTrajectoryForPrompt(
	trajectory: SkillTrajectory,
	options: {
		statusLabel?: string;
		includeStepCount?: boolean;
		blankLineAfterHeader?: boolean;
	} = {},
): string {
	const {
		statusLabel = "Status",
		includeStepCount = false,
		blankLineAfterHeader = false,
	} = options;
	const steps = trajectory.steps ?? [];
	const lines: string[] = [];
	lines.push(`Trajectory: ${trajectory.trajectoryId}`);
	lines.push(`${statusLabel}: ${trajectory.metrics?.finalStatus ?? "unknown"}`);
	if (includeStepCount) {
		lines.push(`Step count: ${steps.length}`);
	}
	if (blankLineAfterHeader) {
		lines.push("");
	}

	for (const [index, step] of steps.entries()) {
		lines.push(`--- Step ${index + 1} ---`);
		for (const call of step.llmCalls ?? []) {
			const purpose = call.purpose ?? call.actionType ?? "step";
			lines.push(`[${purpose}]`);
			if (call.userPrompt) {
				lines.push(`USER: ${call.userPrompt.slice(0, 600)}`);
			}
			if (call.response) {
				lines.push(`AGENT: ${call.response.slice(0, 600)}`);
			}
		}
	}
	return lines.join("\n");
}
