/**
 * Helper that resolves the system prompt for one of the five core decision
 * tasks. Each runtime call site already constructs a baseline prompt; this
 * resolver consults `OptimizedPromptService` first and falls back to the
 * baseline when no artifact has been loaded.
 *
 * Surgical-on-purpose: do NOT thread a runtime through this module. Callers
 * pass the service directly so this helper stays a pure function.
 */

import type {
	OptimizedPromptFewShotExample,
	OptimizedPromptService,
	OptimizedPromptTask,
} from "./optimized-prompt.js";

/**
 * Look up the optimized system prompt for `task`. Returns the baseline
 * unchanged when no service is registered or when the service has no
 * artifact for the task.
 *
 * When the artifact carries `fewShotExamples`, they are inlined into the
 * system prompt under a `Demonstrations:` block. The structure mirrors
 * `apps/app-training/src/optimizers/bootstrap-fewshot.ts#renderDemonstrations`
 * so an artifact written by either backend renders identically at the call
 * site.
 */
export function resolveOptimizedPrompt(
	service: OptimizedPromptService | null | undefined,
	task: OptimizedPromptTask,
	baseline: string,
): string {
	if (!service) return baseline;
	const optimized = service.getPrompt(task);
	if (!optimized) return baseline;
	if (
		!optimized.fewShotExamples ||
		optimized.fewShotExamples.length === 0
	) {
		return optimized.prompt;
	}
	return injectDemonstrations(optimized.prompt, optimized.fewShotExamples);
}

function injectDemonstrations(
	prompt: string,
	examples: OptimizedPromptFewShotExample[],
): string {
	if (prompt.includes("Demonstrations:")) {
		// The artifact already had demonstrations rendered into the prompt
		// (this is how bootstrap-fewshot writes its artifacts). Don't
		// double-inject.
		return prompt;
	}
	const lines: string[] = [prompt.trimEnd(), "", "Demonstrations:", ""];
	let idx = 1;
	for (const example of examples) {
		lines.push(`Example ${idx}:`);
		lines.push(`Input:\n${example.input.user}`);
		lines.push(`Expected:\n${example.expectedOutput}`);
		lines.push("");
		idx += 1;
	}
	return lines.join("\n").trimEnd();
}
