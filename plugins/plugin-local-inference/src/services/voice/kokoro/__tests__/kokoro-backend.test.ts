import { describe, expect, it } from "vitest";
import { scoreFirstResponseLatency } from "../../e2e-harness";
import type {
	AudioSink,
	Phrase,
	SpeakerPreset,
	TtsPcmChunk,
} from "../../types";
import {
	KOKORO_MOBILE_TTFA_BUDGET_MS,
	KokoroTtsBackend,
} from "../kokoro-backend";
import type { KokoroRuntime, KokoroRuntimeInputs } from "../kokoro-runtime";
import { KokoroMockRuntime } from "../kokoro-runtime";
import type { KokoroPhonemizer } from "../types";
import { KOKORO_DEFAULT_VOICE_ID } from "../voices";

function fixedPhonemizer(): KokoroPhonemizer {
	return {
		id: "fixed",
		async phonemize() {
			return { ids: Int32Array.from([1, 43, 60, 2]), phonemes: "ab" };
		},
	};
}

function makePreset(voiceId: string): SpeakerPreset {
	return {
		voiceId,
		embedding: new Float32Array(8),
		bytes: new Uint8Array(8),
	};
}

function makePhrase(text: string): Phrase {
	return {
		id: 1,
		text,
		fromIndex: 0,
		toIndex: text.length - 1,
		terminator: "punctuation",
	};
}

function makeBackend(opts?: { totalSamples?: number; chunkCount?: number }): {
	backend: KokoroTtsBackend;
	runtime: KokoroMockRuntime;
} {
	const runtime = new KokoroMockRuntime({
		sampleRate: 24000,
		totalSamples: opts?.totalSamples ?? 9600, // 0.4s
		chunkCount: opts?.chunkCount ?? 4,
	});
	const backend = new KokoroTtsBackend({
		runtime,
		layout: {
			root: "/tmp/kokoro",
			modelFile: "kokoro-82m-v1_0.gguf",
			voicesDir: "/tmp/kokoro/voices",
			sampleRate: 24000,
		},
		defaultVoiceId: KOKORO_DEFAULT_VOICE_ID,
		phonemizer: fixedPhonemizer(),
		streamingChunkSamples: 1200, // 50ms — re-chunks the mock output
	});
	return { backend, runtime };
}

describe("KokoroTtsBackend", () => {
	it("streams PCM chunks and emits a zero-length final tail", async () => {
		const { backend, runtime } = makeBackend({
			totalSamples: 9600,
			chunkCount: 4,
		});
		const chunks: TtsPcmChunk[] = [];
		const result = await backend.synthesizeStream({
			phrase: makePhrase("hello"),
			preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
			cancelSignal: { cancelled: false },
			onChunk: (c) => {
				chunks.push({
					pcm: new Float32Array(c.pcm),
					sampleRate: c.sampleRate,
					isFinal: c.isFinal,
				});
				return undefined;
			},
		});
		expect(result.cancelled).toBe(false);
		expect(runtime.calls).toBe(1);
		expect(chunks.length).toBeGreaterThan(1);
		const last = chunks[chunks.length - 1];
		expect(last).toBeDefined();
		expect(last?.isFinal).toBe(true);
		expect(last?.pcm.length).toBe(0);
		const bodyChunks = chunks.slice(0, -1);
		expect(bodyChunks.every((c) => !c.isFinal)).toBe(true);
		expect(bodyChunks.every((c) => c.sampleRate === 24000)).toBe(true);
		// Re-chunking honoured: every body chunk respects the 1200-sample cap.
		expect(bodyChunks.every((c) => c.pcm.length <= 1200)).toBe(true);
		const totalBody = bodyChunks.reduce((n, c) => n + c.pcm.length, 0);
		expect(totalBody).toBe(9600);
	});

	it("passes the raw phrase text — never the IPA string — to the runtime (#10726)", async () => {
		const seen: Array<{ text: string; phonemes: string }> = [];
		class RecordingRuntime implements KokoroRuntime {
			readonly id = "mock" as const;
			readonly sampleRate = 24000;
			async synthesize(
				args: KokoroRuntimeInputs,
			): Promise<{ cancelled: boolean }> {
				seen.push({ text: args.text, phonemes: args.phonemes.phonemes });
				args.onChunk({
					pcm: new Float32Array(0),
					sampleRate: this.sampleRate,
					isFinal: true,
				});
				return { cancelled: false };
			}
			dispose(): void {}
		}
		const backend = new KokoroTtsBackend({
			runtime: new RecordingRuntime(),
			layout: {
				root: "/tmp/kokoro",
				modelFile: "kokoro-82m-v1_0.gguf",
				voicesDir: "/tmp/kokoro/voices",
				sampleRate: 24000,
			},
			defaultVoiceId: KOKORO_DEFAULT_VOICE_ID,
			phonemizer: fixedPhonemizer(),
		});
		await backend.synthesizeStream({
			phrase: makePhrase("hello there"),
			preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
			cancelSignal: { cancelled: false },
			onChunk: () => undefined,
		});
		expect(seen).toHaveLength(1);
		// The fused engine phonemizes internally; handing it the JS-side IPA
		// string double-phonemizes into unintelligible audio (#10726).
		expect(seen[0]?.text).toBe("hello there");
		expect(seen[0]?.phonemes).toBe("ab");
		expect(seen[0]?.text).not.toBe(seen[0]?.phonemes);
	});

	it("propagates cancelSignal at chunk boundaries", async () => {
		const { backend } = makeBackend({ totalSamples: 24000, chunkCount: 8 });
		const cancelSignal = { cancelled: false };
		let received = 0;
		const result = await backend.synthesizeStream({
			phrase: makePhrase("a longer line"),
			preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
			cancelSignal,
			onChunk: (c) => {
				if (!c.isFinal) {
					received++;
					if (received === 2) cancelSignal.cancelled = true;
				}
				return undefined;
			},
		});
		expect(result.cancelled).toBe(true);
		// Final tail is always emitted, even on cancel.
		// received counts body chunks only; the runtime stops once cancelled.
		expect(received).toBeLessThanOrEqual(3);
	});

	it("synthesize() concatenates streamed chunks into one AudioChunk", async () => {
		const { backend } = makeBackend({ totalSamples: 9600, chunkCount: 4 });
		const chunk = await backend.synthesize({
			phrase: makePhrase("hi"),
			preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
			cancelSignal: { cancelled: false },
		});
		expect(chunk.sampleRate).toBe(24000);
		expect(chunk.pcm.length).toBe(9600);
		expect(chunk.phraseId).toBe(1);
	});

	it("falls back to the default voice when preset.voiceId is unknown", async () => {
		const { backend } = makeBackend();
		const chunk = await backend.synthesize({
			phrase: makePhrase("hi"),
			preset: makePreset("does_not_exist"),
			cancelSignal: { cancelled: false },
		});
		expect(chunk.pcm.length).toBeGreaterThan(0);
	});

	it("supportsStreamingTts() returns true (satisfies the streaming seam)", () => {
		const { backend } = makeBackend();
		expect(backend.supportsStreamingTts()).toBe(true);
	});
});

// ── TTFA: the first AUDIBLE chunk streams out before the phrase finishes ──
//
// These lock the streaming-TTFA contract (issue #8787 acceptance criterion 7)
// deterministically — no native model, no wall-clock flakiness. The gated
// real-FFI synth that measures TTFA against a true Kokoro forward lives in
// `kokoro-engine-bridge.real.test.ts` and skips when artifacts are absent.

/**
 * A runtime that emits `chunkCount` body chunks and records, for every body
 * chunk, how many runtime chunks had been produced when the backend re-emitted
 * its first audible slice. Proves TTFA is bounded by ONE runtime forward
 * boundary, not the whole phrase.
 */
class CountingKokoroRuntime implements KokoroRuntime {
	readonly id = "mock" as const;
	readonly sampleRate = 24000;
	emitted = 0;
	constructor(
		private readonly totalSamples: number,
		private readonly chunkCount: number,
	) {}
	async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
		const perChunk = Math.max(
			1,
			Math.ceil(this.totalSamples / this.chunkCount),
		);
		for (let off = 0; off < this.totalSamples; off += perChunk) {
			if (args.cancelSignal.cancelled) return { cancelled: true };
			const n = Math.min(perChunk, this.totalSamples - off);
			this.emitted++;
			const want = args.onChunk({
				pcm: new Float32Array(n).fill(0.05),
				sampleRate: this.sampleRate,
				isFinal: false,
			});
			if (want === true) return { cancelled: true };
		}
		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		return { cancelled: false };
	}
	dispose(): void {}
}

describe("KokoroTtsBackend — streaming TTFA", () => {
	it("emits the first audible chunk from the first runtime forward (sub-phrase TTFA)", async () => {
		const runtime = new CountingKokoroRuntime(48000, 4); // 2s across 4 forwards
		const backend = new KokoroTtsBackend({
			runtime,
			layout: {
				root: "/tmp/kokoro",
				modelFile: "kokoro-82m-v1_0.gguf",
				voicesDir: "/tmp/kokoro/voices",
				sampleRate: 24000,
			},
			defaultVoiceId: KOKORO_DEFAULT_VOICE_ID,
			phonemizer: fixedPhonemizer(),
			streamingChunkSamples: 1200, // 50ms slices
		});

		let firstAudibleAtRuntimeEmits = -1;
		let firstAudibleSamples = -1;
		await backend.synthesizeStream({
			phrase: makePhrase("a full sentence that decodes in one forward"),
			preset: makePreset(KOKORO_DEFAULT_VOICE_ID),
			cancelSignal: { cancelled: false },
			onChunk: (c) => {
				if (!c.isFinal && c.pcm.length > 0 && firstAudibleAtRuntimeEmits < 0) {
					firstAudibleAtRuntimeEmits = runtime.emitted;
					firstAudibleSamples = c.pcm.length;
				}
				return undefined;
			},
		});

		// The listener hears audio after the FIRST runtime forward, not all 4.
		expect(firstAudibleAtRuntimeEmits).toBe(1);
		// The first audible chunk is a bounded sub-phrase slice, not the phrase.
		expect(firstAudibleSamples).toBeGreaterThan(0);
		expect(firstAudibleSamples).toBeLessThanOrEqual(1200);
	});

	it("a mobile-class TTFA gate passes within budget and fails past it", () => {
		// Representative warm-handle Kokoro first-phrase TTFB (~97ms TTFB +
		// phonemize). Well within the mobile budget.
		const within = scoreFirstResponseLatency({
			turnStartedAtMs: 1_000,
			ttsFirstAudioAtMs: 1_000 + 180,
			maxFirstAudioMs: KOKORO_MOBILE_TTFA_BUDGET_MS,
		});
		expect(within.firstAudioMs).toBe(180);
		expect(within.passed).toBe(true);

		// A regression that blows the budget must fail the gate, never silently pass.
		const blown = scoreFirstResponseLatency({
			turnStartedAtMs: 1_000,
			ttsFirstAudioAtMs: 1_000 + KOKORO_MOBILE_TTFA_BUDGET_MS + 50,
			maxFirstAudioMs: KOKORO_MOBILE_TTFA_BUDGET_MS,
		});
		expect(blown.passed).toBe(false);
	});
});

// Local declaration so the test file does not import the audio sink (unused).
void (null as unknown as AudioSink);
