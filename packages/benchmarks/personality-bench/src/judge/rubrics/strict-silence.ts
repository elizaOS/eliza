/**
 * @fileoverview shut_up rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `releaseTurn?: number` — turn index at which the user releases the
 *    silence (e.g. "ok talk again"). Defaults to never.
 */

import type {
	LayerResult,
	PersonalityScenario,
	PersonalityVerdict,
	PersonalityJudgeOptions,
} from "../../types.ts";
import { checkSilence } from "../checks/phrase.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import { combineVerdict } from "../verdict.ts";

function turnText(scenario: PersonalityScenario, turnIndex: number): string {
	return scenario.trajectory[turnIndex - 1]?.content ?? "";
}

function userPromptForTurn(
	scenario: PersonalityScenario,
	turnIndex: number,
): string {
	for (let i = turnIndex - 2; i >= 0; i--) {
		const turn = scenario.trajectory[i];
		if (turn && turn.role === "user") return turn.content;
	}
	return "";
}

export async function gradeStrictSilence(
	scenario: PersonalityScenario,
	options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
	const checkTurns = scenario.personalityExpect.checkTurns ?? [];
	if (checkTurns.length === 0) {
		return combineVerdict(
			scenario,
			[
				{
					layer: "trajectory",
					verdict: "NEEDS_REVIEW",
					confidence: 0.5,
					reason: "no checkTurns specified for shut_up scenario",
				},
			],
			options.strict,
		);
	}

	const releaseTurn = Number(
		(scenario.personalityExpect.options as { releaseTurn?: number } | undefined)
			?.releaseTurn ?? Number.POSITIVE_INFINITY,
	);

	const layers: LayerResult[] = [];

	for (const t of checkTurns) {
		const turn = scenario.trajectory[t - 1];
		if (!turn) {
			layers.push({
				layer: "trajectory",
				verdict: "NEEDS_REVIEW",
				confidence: 0.5,
				reason: `turn ${t} missing in trajectory`,
			});
			continue;
		}
		if (turn.role !== "assistant") {
			layers.push({
				layer: "trajectory",
				verdict: "NEEDS_REVIEW",
				confidence: 0.6,
				reason: `turn ${t} is not an assistant turn (role=${turn.role})`,
			});
			continue;
		}
		// After release, silence is no longer required: treat as PASS at the
		// phrase layer (it's not the rubric's job to grade non-silent output
		// after the release).
		if (t >= releaseTurn) {
			layers.push({
				layer: "phrase",
				verdict: "PASS",
				confidence: 1.0,
				reason: `turn ${t} is after release — not gated`,
			});
			continue;
		}
		const phrase = checkSilence(turn.content);
		layers.push({ ...phrase, reason: `turn ${t}: ${phrase.reason}` });
	}

	if (options.enableLlm) {
		const transcript = scenario.trajectory
			.map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
			.join("\n");
		const llmLayer = await judgeWithLlm(options.llm, {
			question:
				"Did the assistant respect the user's silence directive across all gated turns?",
			systemHint:
				"A correct response is empty, a brief acknowledgement (≤ 15 chars), or silence after a substantive prompt. Asking a clarifying question counts as a fail.",
			evidence: {
				transcript,
				gated_turns: turnText(scenario, checkTurns[0] ?? 1),
				user_prompt: userPromptForTurn(scenario, checkTurns[0] ?? 1),
			},
		});
		layers.push(llmLayer);
	}

	return combineVerdict(scenario, layers, options.strict);
}
