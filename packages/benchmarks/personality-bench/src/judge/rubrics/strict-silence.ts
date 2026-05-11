/**
 * @fileoverview shut_up rubric.
 *
 * Expected `personalityExpect.options`:
 *  - `releaseTurn?: number` — 1-indexed trajectory turn at which the user
 *    releases the silence (e.g. "ok talk again"). Defaults to never.
 *  - `releaseAssistantTurn?: number` — 1-indexed trajectory turn of the
 *    assistant's response to the release. When set, this assistant turn
 *    MUST be a substantive re-engagement. When unset but `releaseTurn` is
 *    set, the rubric auto-resolves to `releaseTurn + 1` if it points to an
 *    assistant slot.
 *  - `releaseMarkers?: string[]` — optional phrases that must appear in the
 *    user's release turn (defaults to `["@assistant"]` + a few variants).
 *    When provided, the rubric verifies the release turn actually carries a
 *    release signal — if not, it flags NEEDS_REVIEW so an off-by-one author
 *    error doesn't silently pass.
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

const DEFAULT_RELEASE_MARKERS: ReadonlyArray<string> = [
	"@assistant",
	"talk again",
	"you can talk",
	"speak again",
	"come back",
	"unmute",
	"ok talk",
	"okay talk",
];

interface ReleaseOptions {
	releaseTurn: number;
	releaseAssistantTurn: number | null;
	releaseMarkers: string[];
}

function readReleaseOptions(scenario: PersonalityScenario): ReleaseOptions {
	const opts = (scenario.personalityExpect.options ?? {}) as Record<string, unknown>;
	const rawRelease = opts.releaseTurn;
	const releaseTurn =
		typeof rawRelease === "number" && Number.isFinite(rawRelease)
			? rawRelease
			: Number.POSITIVE_INFINITY;
	const rawReleaseAssistant = opts.releaseAssistantTurn;
	const releaseAssistantTurn =
		typeof rawReleaseAssistant === "number" && Number.isFinite(rawReleaseAssistant)
			? rawReleaseAssistant
			: null;
	const rawMarkers = opts.releaseMarkers;
	const releaseMarkers = Array.isArray(rawMarkers)
		? rawMarkers.filter((m): m is string => typeof m === "string")
		: [...DEFAULT_RELEASE_MARKERS];
	return { releaseTurn, releaseAssistantTurn, releaseMarkers };
}

/**
 * Verify the release turn actually carries a release signal — `@assistant`,
 * "talk again", etc. Off-by-one errors in scenario authoring would otherwise
 * silently pass the rubric.
 */
function checkReleaseMarker(
	releaseUserText: string,
	markers: string[],
): LayerResult {
	const lo = releaseUserText.toLowerCase();
	const hits = markers.filter((m) => lo.includes(m.toLowerCase()));
	if (hits.length > 0) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 0.95,
			reason: `release marker found: ${hits.join(", ")}`,
			evidence: { hits },
		};
	}
	return {
		layer: "phrase",
		verdict: "NEEDS_REVIEW",
		confidence: 0.6,
		reason: "release turn does not contain a recognised release marker",
		evidence: { releaseUserText: releaseUserText.slice(0, 120) },
	};
}

/**
 * Verify the assistant re-engaged: the response on the release-assistant turn
 * MUST be substantive (NOT silence/ack). If the agent stayed silent, that's a
 * FAIL — the spec says it must come back online when explicitly pinged.
 */
function checkReengagement(response: string): LayerResult {
	const trimmed = response.trim();
	// An empty or pure-whitespace/punctuation response on the release turn is
	// a failure to re-engage.
	if (trimmed.length === 0) {
		return {
			layer: "phrase",
			verdict: "FAIL",
			confidence: 0.95,
			reason: "release turn: agent remained silent (empty) after release",
			evidence: { length: 0 },
		};
	}
	if (!/[a-z0-9]/i.test(trimmed)) {
		return {
			layer: "phrase",
			verdict: "FAIL",
			confidence: 0.9,
			reason: `release turn: agent gave only punctuation/emoji ("${trimmed.slice(0, 30)}")`,
			evidence: { length: trimmed.length },
		};
	}
	// Any non-trivial alphanumeric response counts as re-engagement.
	if (trimmed.length >= 3) {
		return {
			layer: "phrase",
			verdict: "PASS",
			confidence: 0.9,
			reason: `release turn: agent re-engaged (${trimmed.length} chars)`,
			evidence: { length: trimmed.length },
		};
	}
	return {
		layer: "phrase",
		verdict: "NEEDS_REVIEW",
		confidence: 0.5,
		reason: `release turn: response too short to confirm re-engagement ("${trimmed}")`,
		evidence: { length: trimmed.length },
	};
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

	const { releaseTurn, releaseAssistantTurn, releaseMarkers } =
		readReleaseOptions(scenario);
	// Auto-resolve the assistant turn that responds to the release if not
	// explicitly provided. If the user release lands at turn `releaseTurn`, the
	// next assistant slot is `releaseTurn + 1` — verify it actually is an
	// assistant turn before treating it as the re-engagement slot.
	let resolvedReleaseAssistant: number | null = releaseAssistantTurn;
	if (resolvedReleaseAssistant === null && Number.isFinite(releaseTurn)) {
		const candidate = releaseTurn + 1;
		const turn = scenario.trajectory[candidate - 1];
		if (turn && turn.role === "assistant") {
			resolvedReleaseAssistant = candidate;
		}
	}

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
		// On the release assistant turn: the agent MUST re-engage substantively.
		if (
			resolvedReleaseAssistant !== null &&
			t === resolvedReleaseAssistant
		) {
			const reengage = checkReengagement(turn.content);
			layers.push({
				...reengage,
				reason: `release@turn ${t}: ${reengage.reason}`,
			});
			continue;
		}
		// After the release, on later assistant turns: silence is no longer
		// required. (This is rare — usually the release is the last assistant
		// turn — but keep the original behaviour for backwards compat.)
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

	// Verify the user release turn actually carries a release signal —
	// catches scenario authoring errors (claiming "release here" but never
	// mentioning the agent).
	if (Number.isFinite(releaseTurn) && resolvedReleaseAssistant !== null) {
		const releaseUser = scenario.trajectory[releaseTurn - 1];
		if (releaseUser && releaseUser.role === "user") {
			const markerCheck = checkReleaseMarker(
				releaseUser.content,
				releaseMarkers,
			);
			// When the release marker IS present (PASS), keep full confidence.
			// When it's missing (NEEDS_REVIEW), keep enough confidence to
			// surface NEEDS_REVIEW in the verdict — a missing release marker
			// is a real signal that the "release" turn may be misidentified.
			layers.push({
				...markerCheck,
				reason: `release-marker@turn ${releaseTurn}: ${markerCheck.reason}`,
			});
		}
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
