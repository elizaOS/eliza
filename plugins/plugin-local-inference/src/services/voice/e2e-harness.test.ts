/** Covers the voice E2E harness core scoring: WER, artifact validation, and barge-in. Deterministic, fixture inputs. */
import { describe, expect, it } from "vitest";
import {
	assertRequiredVoiceArtifacts,
	scoreBargeInGating,
	scoreBargeInInterruption,
	scoreErle,
	scoreFirstResponseLatency,
	scoreOptimisticRollbackRestart,
	scorePartialMonotonicity,
	scorePauseContinuation,
	scoreTtsAsrRoundTrip,
	summarizeVoiceE2e,
	VoiceE2eHarnessError,
	wordErrorRate,
} from "./e2e-harness";

describe("voice E2E harness WER scoring", () => {
	it("normalizes punctuation and computes word error rate", () => {
		expect(wordErrorRate("Hello, local voice!", "hello local voice")).toBe(0);
		expect(wordErrorRate("alpha beta gamma", "alpha gamma")).toBeCloseTo(
			1 / 3,
			4,
		);
	});

	it("scores TTS -> ASR roundtrip against a WER threshold", () => {
		const pass = scoreTtsAsrRoundTrip({
			referenceText: "Eliza local voice smoke.",
			hypothesisText: "eliza local voice smoke",
			maxWer: 0,
		});
		expect(pass.passed).toBe(true);
		expect(pass.wer).toBe(0);

		const fail = scoreTtsAsrRoundTrip({
			referenceText: "one two three four",
			hypothesisText: "one four",
			maxWer: 0.25,
		});
		expect(fail.passed).toBe(false);
		expect(fail.wer).toBe(0.5);
	});
});

describe("voice E2E harness artifact validation", () => {
	it("fails clearly when a required model artifact is missing", () => {
		expect(() =>
			assertRequiredVoiceArtifacts(
				[
					{ kind: "bundle-root", path: "/models/eliza-1-2b.bundle" },
					{
						kind: "asr-model",
						path: "/models/eliza-1-2b.bundle/asr/eliza-1-asr.gguf",
						magic: "GGUF",
					},
				],
				{
					exists: (p) => p.endsWith(".bundle"),
					size: () => null,
					readMagic: () => null,
				},
			),
		).toThrow(/asr-model.*not found/);
	});

	it("rejects a tiny or non-GGUF model instead of accepting a placeholder", () => {
		try {
			assertRequiredVoiceArtifacts(
				[
					{
						kind: "tts-model",
						path: "/tmp/placeholder.gguf",
						minBytes: 1024,
						magic: "GGUF",
					},
				],
				{
					exists: () => true,
					size: () => 12,
					readMagic: () => "NOPE",
				},
			);
			throw new Error("expected artifact validation to fail");
		} catch (err) {
			expect(err).toBeInstanceOf(VoiceE2eHarnessError);
			expect((err as VoiceE2eHarnessError).code).toBe("missing-artifact");
			expect(String((err as Error).message)).toContain("too small");
		}
	});
});

describe("voice E2E harness barge-in scoring", () => {
	it("passes when TTS, LLM, and audio drain cancel inside the budget", () => {
		const result = scoreBargeInInterruption({
			voiceDetectedAtMs: 1000,
			ttsCancelledAtMs: 1060,
			llmCancelledAtMs: 1100,
			audioDrainedAtMs: 1030,
			maxCancelMs: 250,
		});
		expect(result.passed).toBe(true);
		expect(result.bargeInCancelMs).toBe(100);
	});

	it("does not pass a missing LLM cancel measurement by default", () => {
		expect(() =>
			scoreBargeInInterruption({
				voiceDetectedAtMs: 1000,
				ttsCancelledAtMs: 1030,
			}),
		).toThrow(/llmCancelledAtMs/);
	});
});

describe("voice E2E harness pause and rollback scoring", () => {
	it("scores user continuation within the 4s pause window", () => {
		const result = scorePauseContinuation({
			speechPauseAtMs: 1000,
			speculativeStartedAtMs: 1200,
			continuationAtMs: 4700,
			speculativeAbortedAtMs: 4740,
			finalRestartedAtMs: 4900,
		});
		expect(result.passed).toBe(true);
		expect(result.continuationGapMs).toBe(3700);
	});

	it("fails when the partial response committed before the user continued", () => {
		const result = scorePauseContinuation({
			speechPauseAtMs: 1000,
			continuationAtMs: 3000,
			speculativeStartedAtMs: 1100,
			committedBeforeContinuationAtMs: 2500,
			speculativeAbortedAtMs: 3020,
			finalRestartedAtMs: 3100,
		});
		expect(result.passed).toBe(false);
	});

	it("scores optimistic rollback restore and restart timing", () => {
		const result = scoreOptimisticRollbackRestart({
			speechPauseAtMs: 1000,
			checkpointSavedAtMs: 1025,
			speculativeStartedAtMs: 1030,
			continuationAtMs: 1300,
			speculativeAbortedAtMs: 1315,
			checkpointRestoredAtMs: 1370,
			restartedAtMs: 1460,
		});
		expect(result.passed).toBe(true);
		expect(result.restoreAfterContinuationMs).toBe(70);
		expect(result.restartAfterRestoreMs).toBe(90);
	});
});

describe("voice E2E harness latency summary", () => {
	it("scores first response latency from a real timestamp set", () => {
		const result = scoreFirstResponseLatency({
			turnStartedAtMs: 100,
			asrFinalAtMs: 420,
			llmFirstTokenAtMs: 700,
			ttsFirstAudioAtMs: 980,
			audioFirstPlayedAtMs: 1005,
			maxFirstAudioMs: 1000,
		});
		expect(result.passed).toBe(true);
		expect(result.firstAudioMs).toBe(880);
		expect(result.firstPlayedMs).toBe(905);
	});

	it("summarizes all case pass/fail flags", () => {
		const summary = summarizeVoiceE2e([
			scoreTtsAsrRoundTrip({
				referenceText: "hello",
				hypothesisText: "hello",
			}),
			scoreFirstResponseLatency({
				turnStartedAtMs: 0,
				ttsFirstAudioAtMs: 400,
			}),
		]);
		expect(summary.passed).toBe(true);
		expect(summary.cases).toHaveLength(2);
	});
});

describe("scoreBargeInGating — speaker-gated barge-in", () => {
	it("passes when the wake-word cancels in-budget and echo/bystander hold", () => {
		const result = scoreBargeInGating([
			{ expectCancel: true, cancelMs: 120 },
			{ expectCancel: false, cancelMs: null },
			{ expectCancel: false, cancelMs: null },
		]);
		expect(result.passed).toBe(true);
		expect(result.gatingAccuracy).toBe(1);
		expect(result.worstCancelMs).toBe(120);
		expect(result.wrongCancels).toBe(0);
		expect(result.missedCancels).toBe(0);
	});

	it("fails hard when the agent's echo hard-stops the agent (wrong cancel)", () => {
		const result = scoreBargeInGating([
			{ expectCancel: true, cancelMs: 100 },
			{ expectCancel: false, cancelMs: 40 }, // echo cancelled — must not
		]);
		expect(result.passed).toBe(false);
		expect(result.wrongCancels).toBe(1);
	});

	it("fails when a legitimate barge-in cancels past the budget", () => {
		const result = scoreBargeInGating([{ expectCancel: true, cancelMs: 400 }]);
		expect(result.passed).toBe(false);
		expect(result.missedCancels).toBe(1);
	});

	it("fails when a legitimate barge-in is never actioned", () => {
		const result = scoreBargeInGating([{ expectCancel: true, cancelMs: null }]);
		expect(result.passed).toBe(false);
		expect(result.missedCancels).toBe(1);
		expect(result.worstCancelMs).toBeNull();
	});
});

describe("scoreErle — echo-return-loss floor", () => {
	it("passes when the worst turn clears the floor", () => {
		const result = scoreErle([{ erleDb: 22 }, { erleDb: 19.5 }], {
			minErleDb: 18,
		});
		expect(result.passed).toBe(true);
		expect(result.worstErleDb).toBe(19.5);
	});

	it("fails on the worst turn, not the mean (one weak burst)", () => {
		const result = scoreErle([{ erleDb: 30 }, { erleDb: 12 }], {
			minErleDb: 18,
		});
		expect(result.passed).toBe(false);
		expect(result.worstErleDb).toBe(12);
	});

	it("treats an empty measurement set as unscored, never a pass", () => {
		const result = scoreErle([], { minErleDb: 18 });
		expect(result.passed).toBe(false);
		expect(result.total).toBe(0);
	});

	it("counts +Infinity (silent residual) as clearing the floor", () => {
		const result = scoreErle([{ erleDb: Number.POSITIVE_INFINITY }], {
			minErleDb: 18,
		});
		expect(result.passed).toBe(true);
	});
});

describe("scorePartialMonotonicity — committed prefix never retracts", () => {
	it("passes a strictly growing partial stream", () => {
		const result = scorePartialMonotonicity([
			"what",
			"what is",
			"what is the",
			"what is the time",
		]);
		expect(result.passed).toBe(true);
		expect(result.retractions).toBe(0);
		expect(result.total).toBe(3);
	});

	it("flags a retraction when a later partial rewrites the committed prefix", () => {
		const result = scorePartialMonotonicity([
			"set a timer",
			"set a timer for",
			"set the timer for", // "a" → "the": retraction
		]);
		expect(result.passed).toBe(false);
		expect(result.retractions).toBe(1);
	});

	it("does not pass a single-element stream (nothing to prove)", () => {
		expect(scorePartialMonotonicity(["hello"]).passed).toBe(false);
		expect(scorePartialMonotonicity([]).passed).toBe(false);
	});
});
