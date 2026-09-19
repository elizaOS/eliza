/** Resolves complete prompt text through an optional registered service without owning artifacts or task catalogs. */

import { ElizaError } from "../errors.ts";
import { toWellFormedUnicode } from "../utils/well-formed.ts";
export const OPTIMIZED_PROMPT_SERVICE = "optimized_prompt";

/** Complete demonstration content supplied by the registered prompt service. */
export interface RuntimePromptDemonstration {
	input: { system?: string; user: string };
	expectedOutput: string;
}

/** Storage-independent prompt substitution contract. */
export interface RuntimePromptResolver {
	getPrompt(
		task: string,
		baseline?: string,
	): {
		prompt: string;
		fewShotExamples?: RuntimePromptDemonstration[];
	} | null;
}

/**
 * Minimal shape of `IAgentRuntime` we need to look up the
 * `OptimizedPromptService` registration. Defined here so this module does not
 * pull a runtime-types dependency just to read one service. Mirrors the same
 * shape used by `planner-loop.ts:resolveOptimizedPlannerTemplate`.
 */
export interface OptimizedPromptRuntimeLike {
	getService?: (name: string) => unknown;
}

/**
 * Look up the optimized system prompt for `task`. Returns the baseline
 * unchanged when no service is registered or when the service has no
 * artifact for the task.
 *
 * When the artifact carries `fewShotExamples`, they are inlined into the
 * system prompt under a `Demonstrations:` block using the canonical core
 * artifact shape, so every offline producer renders identically at the call
 * site.
 */
export function resolveOptimizedPrompt(
	service: RuntimePromptResolver | null | undefined,
	task: string,
	baseline: string,
): string {
	if (!service) return baseline;
	const optimized = service.getPrompt(task, baseline);
	if (!optimized) return baseline;
	if (!optimized.fewShotExamples || optimized.fewShotExamples.length === 0) {
		return optimized.prompt;
	}
	return injectDemonstrations(optimized.prompt, optimized.fewShotExamples);
}

/** Retain the complete recorded input. The legacy export name remains compatible. */
export function trimDemonstrationInput(rawInput: string): string {
	return completeDemonstrationText(rawInput);
}

function completeDemonstrationText(value: string): string {
	if (toWellFormedUnicode(value) !== value)
		throw new ElizaError(
			"Optimized prompt text contains an unpaired Unicode surrogate; regenerate the complete artifact",
			{
				code: "OPTIMIZED_PROMPT_INVALID_UNICODE",
			},
		);
	return value;
}

function injectDemonstrations(
	prompt: string,
	examples: RuntimePromptDemonstration[],
): string {
	const lines: string[] = [
		completeDemonstrationText(prompt),
		"",
		"Demonstrations:",
		"",
	];
	let idx = 1;
	for (const example of examples) {
		lines.push(`Example ${idx}:`);
		if (example.input.system !== undefined)
			lines.push(`System:\n${completeDemonstrationText(example.input.system)}`);
		lines.push(`Input:\n${trimDemonstrationInput(example.input.user)}`);
		lines.push(
			`Expected:\n${completeDemonstrationText(example.expectedOutput)}`,
		);
		lines.push("");
		idx += 1;
	}
	return lines.join("\n");
}

/** Looks up the optional service; an absent registration preserves the supplied baseline. */
export function resolveOptimizedPromptForRuntime(
	runtime: OptimizedPromptRuntimeLike,
	task: string,
	baseline: string,
): string {
	const service =
		(runtime.getService?.(OPTIMIZED_PROMPT_SERVICE) as
			| RuntimePromptResolver
			| null
			| undefined) ?? null;
	return resolveOptimizedPrompt(service, task, baseline);
}
