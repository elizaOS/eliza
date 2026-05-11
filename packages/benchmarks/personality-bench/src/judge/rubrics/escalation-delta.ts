/**
 * @fileoverview escalation rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `direction: "warmer" | "cooler" | "terser" | "looser"`
 *  - `requireStrictMonotonic?: boolean` — when true, each step must move; when
 *    false (default), only the net delta across the first/last checked turn
 *    must move in the right direction.
 */

import type {
	LayerResult,
	PersonalityScenario,
	PersonalityVerdict,
	PersonalityJudgeOptions,
} from "../../types.ts";
import { tokenCount, warmthScore } from "../checks/phrase.ts";
import { judgeWithLlm } from "../checks/llm-judge.ts";
import { combineVerdict } from "../verdict.ts";

type Direction = "warmer" | "cooler" | "terser" | "looser";

interface EscalationOptions {
	direction: Direction;
	requireStrictMonotonic: boolean;
}

function readOptions(scenario: PersonalityScenario): EscalationOptions {
	const opts = (scenario.personalityExpect.options ?? {}) as Record<string, unknown>;
	return {
		direction: (opts.direction as Direction) ?? "warmer",
		requireStrictMonotonic: Boolean(opts.requireStrictMonotonic),
	};
}

function scoreFor(direction: Direction, text: string): number {
	switch (direction) {
		case "warmer":
		case "cooler":
			return warmthScore(text);
		case "terser":
		case "looser":
			return tokenCount(text);
		default:
			return 0;
	}
}

function expectedSign(direction: Direction): 1 | -1 {
	switch (direction) {
		case "warmer":
		case "looser":
			return 1;
		case "cooler":
		case "terser":
			return -1;
		default:
			return 1;
	}
}

export async function gradeEscalationDelta(
	scenario: PersonalityScenario,
	options: PersonalityJudgeOptions,
): Promise<PersonalityVerdict> {
	const { direction, requireStrictMonotonic } = readOptions(scenario);
	const checkTurns = scenario.personalityExpect.checkTurns ?? [];
	const layers: LayerResult[] = [];

	if (checkTurns.length < 2) {
		return combineVerdict(
			scenario,
			[
				{
					layer: "trajectory",
					verdict: "NEEDS_REVIEW",
					confidence: 0.5,
					reason: "escalation rubric needs ≥ 2 checkTurns",
				},
			],
			options.strict,
		);
	}

	const responses: { turn: number; score: number; text: string }[] = [];
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
		responses.push({ turn: t, score: scoreFor(direction, turn.content), text: turn.content });
	}

	if (responses.length >= 2) {
		const sign = expectedSign(direction);
		const first = responses[0];
		const last = responses[responses.length - 1];
		if (!first || !last) {
			layers.push({
				layer: "trajectory",
				verdict: "NEEDS_REVIEW",
				confidence: 0.5,
				reason: "could not extract first/last escalation response",
			});
		} else {
			const netDelta = (last.score - first.score) * sign;
			if (netDelta > 0) {
				layers.push({
					layer: "trajectory",
					verdict: "PASS",
					confidence: 0.85,
					reason: `net ${direction} delta = ${netDelta.toFixed(2)} (${first.score.toFixed(2)} → ${last.score.toFixed(2)})`,
					evidence: { responses: responses.map((r) => ({ turn: r.turn, score: r.score })) },
				});
			} else if (netDelta === 0) {
				// Zero movement when the user explicitly asked for sequential
				// change is a fail. Confidence is moderate (0.9) — strong enough
				// to dominate the verdict but allows a high-confidence LLM
				// disagreement to escalate to NEEDS_REVIEW.
				layers.push({
					layer: "trajectory",
					verdict: "FAIL",
					confidence: 0.9,
					reason: `no movement across escalation (${first.score.toFixed(2)} → ${last.score.toFixed(2)})`,
				});
			} else {
				layers.push({
					layer: "trajectory",
					verdict: "FAIL",
					confidence: 0.9,
					reason: `escalation went the wrong way: ${first.score.toFixed(2)} → ${last.score.toFixed(2)}`,
				});
			}

			if (requireStrictMonotonic) {
				for (let i = 1; i < responses.length; i++) {
					const a = responses[i - 1];
					const b = responses[i];
					if (!a || !b) continue;
					const step = (b.score - a.score) * sign;
					if (step <= 0) {
						layers.push({
							layer: "trajectory",
							verdict: "FAIL",
							confidence: 0.9,
							reason: `step turn ${a.turn} → ${b.turn} did not move ${direction}`,
						});
						break;
					}
				}
			}
		}
	}

	if (options.enableLlm) {
		const transcript = scenario.trajectory
			.map((t, i) => `[${i + 1}][${t.role}] ${t.content}`)
			.join("\n");
		const llmLayer = await judgeWithLlm(options.llm, {
			question: `Across the checked assistant turns, did each response move ${direction} compared to the previous one?`,
			systemHint:
				"Escalation rubrics test sequential change. Identical responses or movement in the wrong direction is a fail.",
			evidence: {
				transcript,
				direction,
				checkTurns: checkTurns.join(","),
			},
		});
		layers.push(llmLayer);
	}

	return combineVerdict(scenario, layers, options.strict);
}
