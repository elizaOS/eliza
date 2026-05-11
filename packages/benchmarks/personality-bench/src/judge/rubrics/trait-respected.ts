/**
 * @fileoverview note_trait_unrelated rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `trait: "no-emojis" | "no-buddy" | "wants-code-blocks" | "forbidden-phrases"`
 *  - `forbiddenPhrases?: string[]` — when `trait = forbidden-phrases` OR when
 *    augmenting `no-buddy` with extra terms.
 */

import type {
	LayerResult,
	PersonalityScenario,
	PersonalityVerdict,
	PersonalityJudgeOptions,
} from "../../types.ts";
import {
	checkForbiddenPhrases,
	checkNoEmojis,
	checkRequiredCodeBlock,
} from "../checks/phrase.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import { combineVerdict } from "../verdict.ts";

type Trait = "no-emojis" | "no-buddy" | "wants-code-blocks" | "forbidden-phrases";

interface TraitOptions {
	trait: Trait;
	forbiddenPhrases: string[];
}

function readOptions(scenario: PersonalityScenario): TraitOptions {
	const opts = (scenario.personalityExpect.options ?? {}) as Record<string, unknown>;
	const trait = String(opts.trait ?? "") as Trait;
	const phrasesRaw = opts.forbiddenPhrases;
	const forbiddenPhrases = Array.isArray(phrasesRaw)
		? phrasesRaw.filter((p): p is string => typeof p === "string")
		: [];
	return { trait, forbiddenPhrases };
}

function phraseLayerFor(
	trait: Trait,
	forbiddenPhrases: string[],
	response: string,
): LayerResult {
	switch (trait) {
		case "no-emojis":
			return checkNoEmojis(response);
		case "no-buddy": {
			const phrases =
				forbiddenPhrases.length > 0 ? forbiddenPhrases : ["buddy", "friend"];
			return checkForbiddenPhrases(response, phrases);
		}
		case "wants-code-blocks":
			return checkRequiredCodeBlock(response);
		case "forbidden-phrases":
			return checkForbiddenPhrases(response, forbiddenPhrases);
		default:
			return {
				layer: "phrase",
				verdict: "NEEDS_REVIEW",
				confidence: 0,
				reason: `unknown trait "${trait}"`,
			};
	}
}

export async function gradeTraitRespected(
	scenario: PersonalityScenario,
	options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
	const { trait, forbiddenPhrases } = readOptions(scenario);
	const checkTurns = scenario.personalityExpect.checkTurns ?? [];
	const layers: LayerResult[] = [];

	if (checkTurns.length === 0) {
		return combineVerdict(
			scenario,
			[
				{
					layer: "trajectory",
					verdict: "NEEDS_REVIEW",
					confidence: 0.5,
					reason: "no checkTurns specified for note_trait_unrelated scenario",
				},
			],
			options.strict,
		);
	}

	for (const t of checkTurns) {
		const turn = scenario.trajectory[t - 1];
		if (!turn || turn.role !== "assistant") {
			layers.push({
				layer: "trajectory",
				verdict: "NEEDS_REVIEW",
				confidence: 0.5,
				reason: `turn ${t} missing or not assistant`,
			});
			continue;
		}
		const phrase = phraseLayerFor(trait, forbiddenPhrases, turn.content);
		layers.push({ ...phrase, reason: `turn ${t} (${trait}): ${phrase.reason}` });
	}

	if (options.enableLlm) {
		const transcript = scenario.trajectory
			.map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
			.join("\n");
		const llmLayer = await judgeWithLlm(options.llm, {
			question: `Did the assistant respect the user's stated trait ("${trait}") even on unrelated turns?`,
			systemHint:
				"Traits persist across topics. Even if the conversation pivots, the trait must hold on the checked turns.",
			evidence: {
				transcript,
				trait,
				checkTurns: checkTurns.join(","),
				forbiddenPhrases: forbiddenPhrases.join(", "),
			},
		});
		layers.push(llmLayer);
	}

	return combineVerdict(scenario, layers, options.strict);
}
