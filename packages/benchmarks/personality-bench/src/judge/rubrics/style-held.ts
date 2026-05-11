/**
 * @fileoverview hold_style rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `style: "terse" | "haiku" | "pirate" | "no-hedging" | "no-emojis"`
 *  - `maxTokens?: number` — only for `terse`.
 *  - `embeddingBand?: { min: number; max: number }` — optional similarity band
 *    between pre- and post-directive responses (style should usually push
 *    similarity DOWN, so `max` is typically ~0.85).
 */

import type {
	LayerResult,
	PersonalityScenario,
	PersonalityVerdict,
	PersonalityJudgeOptions,
} from "../../types.ts";
import {
	checkHaiku,
	checkNoEmojis,
	checkNoHedging,
	checkPirate,
	checkTerse,
} from "../checks/phrase.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import { combineVerdict } from "../verdict.ts";

type Style = "terse" | "haiku" | "pirate" | "no-hedging" | "no-emojis";

interface StyleOptions {
	style: Style;
	maxTokens?: number;
}

function readOptions(scenario: PersonalityScenario): StyleOptions {
	const opts = (scenario.personalityExpect.options ?? {}) as Record<string, unknown>;
	const style = String(opts.style ?? "") as Style;
	const maxTokens = typeof opts.maxTokens === "number" ? opts.maxTokens : undefined;
	return { style, maxTokens };
}

function phraseLayerFor(style: Style, response: string, maxTokens: number | undefined): LayerResult {
	switch (style) {
		case "terse":
			return checkTerse(response, maxTokens ?? 12);
		case "haiku":
			return checkHaiku(response);
		case "pirate":
			return checkPirate(response);
		case "no-hedging":
			return checkNoHedging(response);
		case "no-emojis":
			return checkNoEmojis(response);
		default:
			return {
				layer: "phrase",
				verdict: "NEEDS_REVIEW",
				confidence: 0,
				reason: `unknown style "${style}"`,
			};
	}
}

export async function gradeStyleHeld(
	scenario: PersonalityScenario,
	options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
	const { style, maxTokens } = readOptions(scenario);
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
					reason: "no checkTurns specified for hold_style scenario",
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
		const phrase = phraseLayerFor(style, turn.content, maxTokens);
		layers.push({ ...phrase, reason: `turn ${t} (${style}): ${phrase.reason}` });
	}

	if (options.enableLlm) {
		const transcript = scenario.trajectory
			.map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
			.join("\n");
		const llmLayer = await judgeWithLlm(options.llm, {
			question: `Did the assistant hold the requested style ("${style}") on the checked turns?`,
			systemHint:
				"Style directives are sticky: once the user asks for a style, EVERY subsequent assistant turn must reflect it until released.",
			evidence: {
				transcript,
				style,
				checkTurns: checkTurns.join(","),
			},
		});
		layers.push(llmLayer);
	}

	return combineVerdict(scenario, layers, options.strict);
}
