/**
 * Helper that resolves the system prompt for one of the five core decision
 * tasks. Each runtime call site already constructs a baseline prompt; this
 * resolver consults `OptimizedPromptService` first and falls back to the
 * baseline when no artifact has been loaded.
 *
 * Two public entry points:
 *
 *   - `resolveOptimizedPrompt(service, task, baseline)` — pure function;
 *     test-friendly. The caller passes the service it already resolved.
 *   - `resolveOptimizedPromptForRuntime(runtime, task, baseline)` — runtime
 *     helper that looks up the service via `runtime.getService`. Each call
 *     site for one of the five tasks goes through this single entry point,
 *     keyed only on the task name + baseline. There is no per-task code
 *     branching anywhere in the runtime — the service holds the
 *     task→artifact map and the operator's `OPTIMIZED_PROMPT_DISABLE`
 *     allowlist gates substitution uniformly.
 */

import { ElizaError } from "../errors.ts";
import { toWellFormedUnicode } from "../utils/well-formed.ts";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptFewShotExample,
	type OptimizedPromptService,
	type OptimizedPromptTask,
} from "./optimized-prompt.js";

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
	service: OptimizedPromptService | null | undefined,
	task: OptimizedPromptTask,
	baseline: string,
): string {
	if (!service) return baseline;
	const optimized = service.getPrompt(task);
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
	examples: OptimizedPromptFewShotExample[],
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

/**
 * Runtime-aware entry point. Each call site that builds a prompt for one of
 * the five core tasks calls this helper, passing only the runtime, the task
 * name, and the baseline string. The helper:
 *
 *   1. Looks up `OptimizedPromptService` from the runtime (returns baseline
 *      if the service is not registered — important during early-boot or in
 *      stripped-down test runtimes).
 *   2. Asks the service for the resolved prompt for that task. The service
 *      honours `OPTIMIZED_PROMPT_DISABLE`, so a disabled task returns null
 *      from `getPrompt` and we fall back to the baseline here.
 *   3. Inlines few-shot demonstrations into the artifact prompt when present.
 *
 * No call site needs to know which task names exist or how the service is
 * registered; they pass a `task: OptimizedPromptTask` literal and the strong
 * type catches typos at compile time.
 */
export function resolveOptimizedPromptForRuntime(
	runtime: OptimizedPromptRuntimeLike,
	task: OptimizedPromptTask,
	baseline: string,
): string {
	const service =
		(runtime.getService?.(OPTIMIZED_PROMPT_SERVICE) as
			| OptimizedPromptService
			| null
			| undefined) ?? null;
	return resolveOptimizedPrompt(service, task, baseline);
}
