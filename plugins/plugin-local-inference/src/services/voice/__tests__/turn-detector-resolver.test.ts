/**
 * Tests for the Voice Wave 2 turn-detector resolver:
 *
 *   1. `turnDetectorRevisionForTier` — tier ↔ upstream revision routing.
 *      - 0_8b/2b → `v1.2.2-en` (SmolLM2-135M EN-only, ~66 MB Q8 ONNX).
 *      - 4b/9b/27b* → `v0.4.1-intl` (pruned Qwen2.5-0.5B, ~396 MB Q8 ONNX).
 *   2. `createBundledLiveKitTurnDetector` — filename resolution priority:
 *      explicit > env > `onnx/model_q8.onnx` > legacy `model_quantized.onnx`.
 *      Returns `null` when no candidate ONNX is present, so the engine
 *      falls back to `HeuristicEotClassifier`.
 *   3. Cancellation handshake (R11): turn detector emits a `VoiceTurnSignal`
 *      only — it NEVER aborts a turn directly. The controller layer above
 *      consumes the signal and decides whether to suppress (via
 *      `BargeInCancelToken.signal` with reason `"turn-suppressed"`).
 */

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createBundledLiveKitTurnDetector,
	DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX,
	type EotClassifier,
	HeuristicEotClassifier,
	LEGACY_LIVEKIT_TURN_DETECTOR_ONNX,
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
// 2. Bundled resolver — picks the right ONNX filename
// ---------------------------------------------------------------------------

describe("createBundledLiveKitTurnDetector — filename resolution", () => {
	let modelDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		modelDir = await mkdtemp(path.join(tmpdir(), "eliza-turn-resolver-"));
		// Reset env between cases.
		delete process.env.ELIZA_TURN_DETECTOR_MODEL_DIR;
		delete process.env.ELIZA_TURN_DETECTOR_ONNX;
	});

	afterEach(async () => {
		await rm(modelDir, { recursive: true, force: true });
		// Restore env.
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) delete process.env[key];
		}
		Object.assign(process.env, originalEnv);
	});

	async function stub(...rel: string[]): Promise<void> {
		for (const r of rel) {
			const target = path.join(modelDir, r);
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, ""); // empty stub — the real load() will fail.
		}
	}

	it("returns null when nothing is staged", async () => {
		const detector = await createBundledLiveKitTurnDetector({ modelDir });
		expect(detector).toBeNull();
	});

	it("returns null when ONNX exists but tokenizer.json does not", async () => {
		await stub(DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX);
		const detector = await createBundledLiveKitTurnDetector({ modelDir });
		expect(detector).toBeNull();
	});

	// The factory currently always returns null even when the bundle is
	// fully staged: the @huggingface/transformers runtime dependency was
	// removed and the LiveKit detector cannot load its tokenizer without it.
	// Once a ggml/llama.cpp-backed tokenizer lands, these cases should
	// expect `not.toBeNull()` again.

	it("returns null when the canonical bundle is staged (tokenizer dep removed)", async () => {
		await stub(
			DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX,
			LEGACY_LIVEKIT_TURN_DETECTOR_ONNX,
			"tokenizer.json",
		);
		const detector = await createBundledLiveKitTurnDetector({ modelDir });
		expect(detector).toBeNull();
	});

	it("returns null when only the legacy bundle is staged (tokenizer dep removed)", async () => {
		await stub(LEGACY_LIVEKIT_TURN_DETECTOR_ONNX, "tokenizer.json");
		const detector = await createBundledLiveKitTurnDetector({ modelDir });
		expect(detector).toBeNull();
	});

	it("returns null with an explicit onnxFilename (tokenizer dep removed)", async () => {
		await stub(
			DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX,
			"custom/finetune.onnx",
			"tokenizer.json",
		);
		const detector = await createBundledLiveKitTurnDetector({
			modelDir,
			onnxFilename: "custom/finetune.onnx",
		});
		expect(detector).toBeNull();
	});

	it("returns null when the explicit onnxFilename does not exist", async () => {
		await stub(DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX, "tokenizer.json");
		const detector = await createBundledLiveKitTurnDetector({
			modelDir,
			onnxFilename: "missing.onnx",
		});
		// Explicit means "trust the caller" — if they pointed at a missing
		// file, that's a hard miss, not silent fallback to the default.
		expect(detector).toBeNull();
	});

	it("returns null with ELIZA_TURN_DETECTOR_ONNX env override (tokenizer dep removed)", async () => {
		await stub("custom/from-env.onnx", "tokenizer.json");
		process.env.ELIZA_TURN_DETECTOR_ONNX = "custom/from-env.onnx";
		const detector = await createBundledLiveKitTurnDetector({ modelDir });
		expect(detector).toBeNull();
	});

	it("returns null with ELIZA_TURN_DETECTOR_MODEL_DIR env override (tokenizer dep removed)", async () => {
		const otherDir = await mkdtemp(path.join(tmpdir(), "eliza-turn-env-"));
		try {
			const tok = path.join(otherDir, "tokenizer.json");
			const onnx = path.join(otherDir, DEFAULT_LIVEKIT_TURN_DETECTOR_ONNX);
			await mkdir(path.dirname(onnx), { recursive: true });
			await writeFile(tok, "");
			await writeFile(onnx, "");
			process.env.ELIZA_TURN_DETECTOR_MODEL_DIR = otherDir;
			const detector = await createBundledLiveKitTurnDetector({});
			expect(detector).toBeNull();
		} finally {
			await rm(otherDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Heuristic-fallback contract (engine wires this when bundle is absent)
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
// 4. Cancellation handshake (R11) — detector never aborts a turn directly
// ---------------------------------------------------------------------------

describe("cancellation handshake (R11) — detector emits data, never aborts", () => {
	it("a VoiceTurnSignal is data only — no AbortSignal/AbortController surface", async () => {
		const heuristic = new HeuristicEotClassifier();
		const signal = await heuristic.signal("anything");
		// Structural assertion: the signal carries scoring data + telemetry,
		// not any cancellation handle. Any future detector that grew an
		// AbortSignal surface would break the contract documented at
		// `eot-classifier.ts` doc block (lines 39-43) and in
		// `.swarm/research/R1-turn.md` §6.
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
		// "heuristic" | "livekit-turn-detector" | "remote" | "custom".
		// `turn-suppressed` is a cancellation REASON the controller emits on
		// BargeInCancelToken — NOT a signal source. Test guards that the
		// type union here doesn't drift.
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

// ---------------------------------------------------------------------------
// 5. Smoke — verify the bundle resolver does not throw on non-existent dirs
// ---------------------------------------------------------------------------

describe("bundle resolver smoke", () => {
	it("does not throw on a nonexistent modelDir", async () => {
		const nonexistent = path.join(tmpdir(), `eliza-no-such-dir-${Date.now()}`);
		// Make absolutely sure it does not exist.
		await rm(nonexistent, { recursive: true, force: true }).catch(() => {});
		await expect(access(nonexistent)).rejects.toThrow();
		const detector = await createBundledLiveKitTurnDetector({
			modelDir: nonexistent,
		});
		expect(detector).toBeNull();
	});
});
