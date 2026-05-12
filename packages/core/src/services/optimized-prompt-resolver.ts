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
 * system prompt under a `Demonstrations:` block. The structure mirrors
 * `plugins/app-training/src/optimizers/bootstrap-fewshot.ts#renderDemonstrations`
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
	// Wave 2-D: `ELIZA_PROMPT_COMPRESS=1` drops few-shot examples from the
	// optimized prompt. This is the Cerebras "compress" escape hatch — keep
	// the base optimized instruction text but skip the ICL demonstrations to
	// reduce token budget pressure.
	if (
		process.env.ELIZA_PROMPT_COMPRESS === "1" ||
		!optimized.fewShotExamples ||
		optimized.fewShotExamples.length === 0
	) {
		return optimized.prompt;
	}
	return injectDemonstrations(optimized.prompt, optimized.fewShotExamples);
}

/**
 * Trim a recorded planner input down to the bits that meaningfully teach
 * the model in-context. Recorded inputs include the full provider block +
 * tool catalog (often ~30K chars); for ICL we only need the user's
 * current-turn request. Mirrors the same heuristic in
 * `plugins/app-training/src/optimizers/bootstrap-fewshot.ts:trimDemonstrationInput`.
 */
function trimDemonstrationInput(rawInput: string): string {
	const userMatch =
		rawInput.match(
			/(?:^|\n)user(?:\s+message)?\s*:\s*([^\n]+(?:\n(?!\w+:)[^\n]+)*)/i,
		) ??
		rawInput.match(/(?:^|\n)user_message\s*:\s*([^\n]+(?:\n(?!\w+:)[^\n]+)*)/i);
	const candidate = userMatch?.[1]?.trim();
	if (candidate && candidate.length > 0 && candidate.length <= 600) {
		return candidate;
	}
	if (candidate && candidate.length > 0) {
		return `${candidate.slice(0, 600).trimEnd()} …`;
	}
	if (rawInput.length <= 600) return rawInput;
	return `${rawInput.slice(0, 400).trimEnd()}\n…\n${rawInput.slice(-200).trimStart()}`;
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
		lines.push(`Input:\n${trimDemonstrationInput(example.input.user)}`);
		lines.push(`Expected:\n${example.expectedOutput}`);
		lines.push("");
		idx += 1;
	}
	return lines.join("\n").trimEnd();
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
