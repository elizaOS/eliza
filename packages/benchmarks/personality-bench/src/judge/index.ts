/**
 * @fileoverview Public judge entry point.
 *
 * `gradeScenario(scenario, options)` dispatches to the correct rubric. Options
 * are resolved against environment variables when not provided, so the
 * runner / test suite can stay terse.
 */

import type {
	PersonalityScenario,
	PersonalityJudgeOptions,
	PersonalityVerdict,
} from "../types.ts";
import { gradeStrictSilence } from "./rubrics/strict-silence.ts";
import { gradeStyleHeld } from "./rubrics/style-held.ts";
import { gradeTraitRespected } from "./rubrics/trait-respected.ts";
import { gradeEscalationDelta } from "./rubrics/escalation-delta.ts";
import { gradeScopeIsolated } from "./rubrics/scope-isolated.ts";

export function resolveOptions(
	overrides?: Partial<PersonalityJudgeOptions>,
): PersonalityJudgeOptions {
	const apiKey =
		process.env.CEREBRAS_API_KEY?.trim() ||
		process.env.OPENAI_API_KEY?.trim() ||
		"";
	const baseUrl =
		process.env.CEREBRAS_BASE_URL?.trim() ||
		process.env.OPENAI_BASE_URL?.trim() ||
		"https://api.cerebras.ai/v1";
	const model =
		process.env.PERSONALITY_JUDGE_MODEL?.trim() ||
		process.env.EVAL_MODEL?.trim() ||
		process.env.CEREBRAS_MODEL?.trim() ||
		"gpt-oss-120b";
	const passesRaw = Number(process.env.PERSONALITY_JUDGE_PASSES);
	const passes = Number.isFinite(passesRaw) && passesRaw > 0 ? passesRaw : 2;
	const timeoutRaw = Number(process.env.PERSONALITY_JUDGE_TIMEOUT_MS);
	const timeoutMs =
		Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 20000;
	const enableLlmRaw = process.env.PERSONALITY_JUDGE_ENABLE_LLM;
	const enableLlm =
		enableLlmRaw === "0" || enableLlmRaw === "false" ? false : Boolean(apiKey);
	const enableEmbedding = process.env.PERSONALITY_JUDGE_ENABLE_EMBEDDING === "1";
	const strict = process.env.PERSONALITY_JUDGE_STRICT === "1";

	return {
		enableLlm,
		enableEmbedding,
		strict,
		llm: {
			baseUrl,
			apiKey,
			model,
			passes,
			timeoutMs,
		},
		...(overrides ?? {}),
	};
}

export async function gradeScenario(
	scenario: PersonalityScenario,
	overrides?: Partial<PersonalityJudgeOptions>,
): Promise<PersonalityVerdict> {
	const options = resolveOptions(overrides);
	switch (scenario.bucket) {
		case "shut_up":
			return gradeStrictSilence(scenario, options);
		case "hold_style":
			return gradeStyleHeld(scenario, options);
		case "note_trait_unrelated":
			return gradeTraitRespected(scenario, options);
		case "escalation":
			return gradeEscalationDelta(scenario, options);
		case "scope_global_vs_user":
			return gradeScopeIsolated(scenario, options);
		default: {
			const bucket = (scenario as { bucket?: string }).bucket ?? "unknown";
			return {
				scenarioId: scenario.id,
				bucket: scenario.bucket,
				verdict: "NEEDS_REVIEW",
				layers: [
					{
						layer: "trajectory",
						verdict: "NEEDS_REVIEW",
						confidence: 0,
						reason: `unknown bucket "${bucket}"`,
					},
				],
				reason: `unknown bucket "${bucket}"`,
				highConfidencePass: false,
			};
		}
	}
}

export {
	gradeStrictSilence,
	gradeStyleHeld,
	gradeTraitRespected,
	gradeEscalationDelta,
	gradeScopeIsolated,
};
