/**
 * Tests for the Voice Wave 2 turn-detector resolver:
 *
 *   1. `turnDetectorRevisionForTier` — tier ↔ upstream revision routing.
 *      - 0_8b/2b → `v1.2.2-en` (English-only GGUF).
 *      - 4b/9b/27b* → `v0.4.1-intl` (multilingual GGUF).
 *   2. Heuristic fallback contract: `HeuristicEotClassifier` satisfies
 *      `EotClassifier` and emits well-formed `VoiceTurnSignal`s.
 *   3. Cancellation handshake (R11): turn detector emits a `VoiceTurnSignal`
 *      only — it NEVER aborts a turn directly. The controller layer above
 *      consumes the signal and decides whether to suppress (via
 *      `BargeInCancelToken.signal` with reason `"turn-suppressed"`).
 */

import { describe, expect, it } from "vitest";
import {
	type EotClassifier,
	HeuristicEotClassifier,
	LIVEKIT_TURN_DETECTOR_EN_REVISION,
	LIVEKIT_TURN_DETECTOR_INTL_REVISION,
	turnDetectorRevisionForTier,
	turnSignalFromProbability,
	type VoiceTurnSignal,
} from "../eot-classifier";

// ---------------------------------------------------------------------------
// 1. Tier-aware revision routing
// ---------------------------------------------------------------------------

describe("turnDetectorRevisionForTier — tier ↔ revision mapping", () => {
	it.each([
		["0_8b", LIVEKIT_TURN_DETECTOR_EN_REVISION],
		["2b", LIVEKIT_TURN_DETECTOR_EN_REVISION],
		["eliza-1-0_8b", LIVEKIT_TURN_DETECTOR_EN_REVISION],
		["eliza-1-2b", LIVEKIT_TURN_DETECTOR_EN_REVISION],
	])("%s → EN revision (%s)", (tier, expected) => {
		expect(turnDetectorRevisionForTier(tier)).toBe(expected);
	});

	it.each([
		["4b", LIVEKIT_TURN_DETECTOR_INTL_REVISION],
		["9b", LIVEKIT_TURN_DETECTOR_INTL_REVISION],
		["27b", LIVEKIT_TURN_DETECTOR_INTL_REVISION],
		["27b-256k", LIVEKIT_TURN_DETECTOR_INTL_REVISION],
		["eliza-1-4b", LIVEKIT_TURN_DETECTOR_INTL_REVISION],
	])("%s → multilingual revision (%s)", (tier, expected) => {
		expect(turnDetectorRevisionForTier(tier)).toBe(expected);
	});

	it("unknown / future tier falls back to the multilingual revision", () => {
		expect(turnDetectorRevisionForTier("999b")).toBe(
			LIVEKIT_TURN_DETECTOR_INTL_REVISION,
		);
	});

	it("revisions are distinct, non-empty constants", () => {
		expect(LIVEKIT_TURN_DETECTOR_EN_REVISION).not.toBe(
			LIVEKIT_TURN_DETECTOR_INTL_REVISION,
		);
		expect(LIVEKIT_TURN_DETECTOR_EN_REVISION).toBeTruthy();
		expect(LIVEKIT_TURN_DETECTOR_INTL_REVISION).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 2. Heuristic-fallback contract (engine wires this when bundle is absent)
// ---------------------------------------------------------------------------

describe("heuristic fallback when bundled model is absent", () => {
	it("HeuristicEotClassifier satisfies the EotClassifier interface", async () => {
		const heuristic: EotClassifier = new HeuristicEotClassifier();
		expect(typeof heuristic.score).toBe("function");
		expect(typeof heuristic.signal).toBe("function");
		const p = await heuristic.score("hello.");
		expect(p).toBeGreaterThanOrEqual(0);
		expect(p).toBeLessThanOrEqual(1);
	});

	it("returns a valid VoiceTurnSignal", async () => {
		const heuristic = new HeuristicEotClassifier();
		const signal = await heuristic.signal("hello world.");
		expect(signal.source).toBe("heuristic");
		expect(signal.endOfTurnProbability).toBeGreaterThanOrEqual(0);
		expect(signal.endOfTurnProbability).toBeLessThanOrEqual(1);
		// Sentence-terminated → agent should speak (probability >= tentative).
		expect(signal.nextSpeaker).toBe("agent");
		expect(signal.agentShouldSpeak).toBe(true);
	});

	it("mid-clause input → suppress agent reply (nextSpeaker=user)", async () => {
		const heuristic = new HeuristicEotClassifier();
		const signal = await heuristic.signal("I'd like to go to the");
		expect(signal.endOfTurnProbability).toBeLessThan(0.4);
		expect(signal.nextSpeaker).toBe("user");
		expect(signal.agentShouldSpeak).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 3. Cancellation handshake (R11) — detector never aborts a turn directly
// ---------------------------------------------------------------------------

describe("cancellation handshake (R11) — detector emits data, never aborts", () => {
	it("a VoiceTurnSignal is data only — no AbortSignal/AbortController surface", async () => {
		const heuristic = new HeuristicEotClassifier();
		const signal = await heuristic.signal("anything");
		// Structural assertion: the signal carries scoring data + telemetry,
		// not any cancellation handle.
		const allowed = new Set([
			"endOfTurnProbability",
			"nextSpeaker",
			"agentShouldSpeak",
			"source",
			"model",
			"transcript",
			"latencyMs",
		]);
		for (const key of Object.keys(signal)) {
			expect(allowed.has(key)).toBe(true);
		}
		// Belt-and-suspenders: cancellation handles would expose .aborted /
		// .abort / .signal — none of those.
		expect((signal as Record<string, unknown>).aborted).toBeUndefined();
		expect((signal as Record<string, unknown>).abort).toBeUndefined();
		expect((signal as Record<string, unknown>).signal).toBeUndefined();
	});

	it("turnSignalFromProbability classifies suppress vs speak deterministically", () => {
		// p ≥ 0.6 → agent speaks. p < 0.4 → suppress. 0.4 ≤ p < 0.6 → unknown.
		const speak = turnSignalFromProbability({
			probability: 0.95,
			transcript: "done.",
			source: "heuristic",
		});
		expect(speak.nextSpeaker).toBe("agent");
		expect(speak.agentShouldSpeak).toBe(true);

		const suppress = turnSignalFromProbability({
			probability: 0.1,
			transcript: "i want to",
			source: "heuristic",
		});
		expect(suppress.nextSpeaker).toBe("user");
		expect(suppress.agentShouldSpeak).toBe(false);

		const ambiguous = turnSignalFromProbability({
			probability: 0.5,
			transcript: "what about that",
			source: "heuristic",
		});
		expect(ambiguous.nextSpeaker).toBe("unknown");
		expect(ambiguous.agentShouldSpeak).toBeNull();
	});

	it("invalid probability is clamped, never throws (calling code must not surface a cancellation)", () => {
		const fromNaN = turnSignalFromProbability({
			probability: Number.NaN,
			transcript: "x",
			source: "heuristic",
		});
		expect(fromNaN.endOfTurnProbability).toBeGreaterThanOrEqual(0);
		expect(fromNaN.endOfTurnProbability).toBeLessThanOrEqual(1);

		const negative = turnSignalFromProbability({
			probability: -1,
			transcript: "x",
			source: "heuristic",
		});
		expect(negative.endOfTurnProbability).toBe(0);

		const big = turnSignalFromProbability({
			probability: 9.5,
			transcript: "x",
			source: "heuristic",
		});
		expect(big.endOfTurnProbability).toBe(1);
	});

	it("signal source matches expected taxonomy", () => {
		// Sources documented in `VoiceTurnSignal['source']` =
		// "heuristic" | "livekit-turn-detector" | "remote" | "custom" | "eliza-1-drafter".
		const sources: VoiceTurnSignal["source"][] = [
			"heuristic",
			"livekit-turn-detector",
			"remote",
			"custom",
		];
		for (const source of sources) {
			const s = turnSignalFromProbability({
				probability: 0.5,
				transcript: "x",
				source,
			});
			expect(s.source).toBe(source);
		}
	});
});
