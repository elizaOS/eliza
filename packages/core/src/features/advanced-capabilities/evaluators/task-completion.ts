import type { UUID } from "../../../types/index.ts";

export interface TaskCompletionAssessment {
	assessed: boolean;
	completed: boolean;
	reason: string;
	source: "reflection";
	evaluatedAt: number;
	messageId?: UUID;
}

export function getTaskCompletionCacheKey(messageId: UUID): string {
	return `reflection-task-completion:${messageId}`;
}

export function formatTaskCompletionStatus(
	assessment: TaskCompletionAssessment | null | undefined,
): string {
	if (!assessment) {
		return "No task completion reflection is available.";
	}

	return [
		"# Reflection Task Completion",
		`assessed: ${assessment.assessed ? "true" : "false"}`,
		`task_completed: ${assessment.completed ? "true" : "false"}`,
		`task_completion_reason: ${assessment.reason}`,
	].join("\n");
}
