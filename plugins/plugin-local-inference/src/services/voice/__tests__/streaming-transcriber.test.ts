/**
 * Streaming-ASR integration tests against a scripted (mock) FFI.
 *
 * Covers:
 *   1. `FfiStreamingTranscriber` delivers monotonically growing partials in
 *      feed order and a final on flush.
 *   2. `dispose()` cleans up the native handle without flushing first.
 *   3. `pickStreamingMode` selection table + the `ELIZA_VOICE_STREAMING_ASR`
 *      default-on env flag.
 *   4. `StreamingAsrFeeder` stabilizes partials through the word-level
 *      LocalAgreement-2 gate (never a retracted word — property-tested under
 *      random hypothesis churn), announces committed words once, finalizes
 *      once, and emits final tokens via `onFinalTokens`.
 *   5. `StabilizedStreamingTranscriber` re-emits only committed-prefix
 *      partials/words to its subscribers and passes finals through.
 */

import { describe, expect, it } from "vitest";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	ElizaInferenceRegion,
} from "../ffi-bindings";
import {
	pickStreamingMode,
	readStreamingAsrEnabledFromEnv,
	StabilizedStreamingTranscriber,
	StreamingAsrFeeder,
	WordAgreementGate,
} from "../streaming-asr/streaming-pipeline-adapter";
import { ASR_SAMPLE_RATE, FfiStreamingTranscriber } from "../transcriber";
import type {
	PcmFrame,
	TextToken,
	TranscriberEvent,
	TranscriptUpdate,
} from "../types";

/* ---- helpers --------------------------------------------------------- */

interface ScriptedStream {
	partials: ReadonlyArray<{ partial: string; tokens?: number[] }>;
	final: { partial: string; tokens?: number[] };
}

/**
 * Build a fake `ElizaInferenceFfi` that returns a scripted sequence of
 * partials (one per `asrStreamFeed`) and a scripted final on
 * `asrStreamFinish`. Records every feed length so we can assert frame
 * order is preserved.
 */
function scriptedFfi(script: ScriptedStream): {
	ffi: ElizaInferenceFfi;
	state: {
		feeds: number;
		feedLengths: number[];
		closed: boolean;
		openCount: number;
	};
} {
	const state = {
		feeds: 0,
		feedLengths: [] as number[],
		closed: false,
		openCount: 0,
	};
	let handle = 0n;
	const ffi: ElizaInferenceFfi = {
		libraryPath: "/tmp/fake",
		libraryAbiVersion: "3",
		create: (): ElizaInferenceContextHandle => 1n,
		destroy: () => {},
		mmapAcquire: (
			_c: ElizaInferenceContextHandle,
			_r: ElizaInferenceRegion,
		) => {},
		mmapEvict: (
			_c: ElizaInferenceContextHandle,
			_r: ElizaInferenceRegion,
		) => {},
		ttsSynthesize: () => {
			throw new Error("not used");
		},
		asrTranscribe: () => {
			throw new Error("not used");
		},
		ttsStreamSupported: () => false,
		ttsSynthesizeStream: () => {
			throw new Error("not used");
		},
		cancelTts: () => {},
		setVerifierCallback: () => ({ close: () => {} }),
		vadSupported: () => false,
		vadOpen: () => {
			throw new Error("not used");
		},
		vadProcess: () => {
			throw new Error("not used");
		},
		vadReset: () => {},
		vadClose: () => {},
		asrStreamSupported: () => true,
		asrStreamOpen: () => {
			state.openCount += 1;
			handle += 1n;
			return handle;
		},
		asrStreamFeed: ({ pcm }) => {
			state.feedLengths.push(pcm.length);
			state.feeds += 1;
		},
		asrStreamPartial: () => {
			const idx = Math.min(state.feeds - 1, script.partials.length - 1);
			return script.partials[Math.max(0, idx)] ?? { partial: "" };
		},
		asrStreamFinish: () => script.final,
		asrStreamClose: () => {
			state.closed = true;
		},
		close: () => {},
	};
	return { ffi, state };
}

function collect(t: {
	on(l: (e: TranscriberEvent) => void): () => void;
}): TranscriberEvent[] {
	const out: TranscriberEvent[] = [];
	t.on((e) => out.push(e));
	return out;
}

const PCM_FRAME = (samples: number, ts: number): PcmFrame => ({
	pcm: new Float32Array(samples).fill(0.05),
	sampleRate: ASR_SAMPLE_RATE,
	timestampMs: ts,
});

/* ---- FfiStreamingTranscriber ---------------------------------------- */

describe("FfiStreamingTranscriber — frame-by-frame", () => {
	it("emits monotonically growing partials and a final on flush", async () => {
		const script: ScriptedStream = {
			partials: [
				{ partial: "hello", tokens: [11] },
				{ partial: "hello there", tokens: [11, 22] },
				{ partial: "hello there how", tokens: [11, 22, 33] },
			],
			final: {
				partial: "hello there how are you",
				tokens: [11, 22, 33, 44, 55],
			},
		};
		const { ffi, state } = scriptedFfi(script);

		const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		const events = collect(t);

		// 3 frames, one feed each.
		for (let i = 0; i < 3; i++) {
			t.feed(PCM_FRAME(1600, i * 100));
		}

		expect(state.feeds).toBe(3);
		expect(state.openCount).toBe(1);

		const partials = events
			.filter(
				(e): e is TranscriberEvent & { kind: "partial" } =>
					e.kind === "partial",
			)
			.map((e) => e.update.partial);
		expect(partials).toEqual(["hello", "hello there", "hello there how"]);
		// Token ids ride alongside.
		const lastPartial = events
			.filter(
				(e): e is TranscriberEvent & { kind: "partial" } =>
					e.kind === "partial",
			)
			.at(-1);
		expect(lastPartial?.update.tokens).toEqual([11, 22, 33]);

		const final = await t.flush();
		expect(final.partial).toBe("hello there how are you");
		expect(final.isFinal).toBe(true);
		expect(final.tokens).toEqual([11, 22, 33, 44, 55]);
		expect(state.closed).toBe(true);
	});

	it("dispose() closes the native session without flushing", () => {
		const { ffi, state } = scriptedFfi({
			partials: [{ partial: "ok" }],
			final: { partial: "ok done" },
		});
		const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		t.feed(PCM_FRAME(160, 0));
		expect(state.closed).toBe(false);
		t.dispose();
		expect(state.closed).toBe(true);
	});

	it("dispose() is idempotent", () => {
		const { ffi } = scriptedFfi({
			partials: [{ partial: "" }],
			final: { partial: "" },
		});
		const t = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		t.dispose();
		expect(() => t.dispose()).not.toThrow();
	});
});

/* ---- pickStreamingMode --------------------------------------------- */

describe("pickStreamingMode", () => {
	it("returns 'streaming' only when every gate is true", () => {
		expect(
			pickStreamingMode({
				ffiSupportsStreaming: true,
				asrBundlePresent: true,
				enableStreaming: true,
			}),
		).toBe("streaming");
	});

	it.each([
		{
			ffiSupportsStreaming: false,
			asrBundlePresent: true,
			enableStreaming: true,
		},
		{
			ffiSupportsStreaming: true,
			asrBundlePresent: false,
			enableStreaming: true,
		},
		{
			ffiSupportsStreaming: true,
			asrBundlePresent: true,
			enableStreaming: false,
		},
	])("falls back to 'batch' when any gate is false (%j)", (args) => {
		expect(pickStreamingMode(args)).toBe("batch");
	});
});

/* ---- StreamingAsrFeeder -------------------------------------------- */

describe("StreamingAsrFeeder", () => {
	it("emits LocalAgreement-2 committed prefixes + words, and final tokens on finalize", async () => {
		const script: ScriptedStream = {
			partials: [{ partial: "" }, { partial: "hi" }, { partial: "hi there" }],
			final: { partial: "hi there friend", tokens: [1, 2, 3] },
		};
		const { ffi } = scriptedFfi(script);
		const transcriber = new FfiStreamingTranscriber({
			ffi,
			getContext: () => 1n,
		});

		const partials: TranscriptUpdate[] = [];
		const words: string[][] = [];
		const finalEvents: Array<{
			tokens: ReadonlyArray<TextToken>;
			final: TranscriptUpdate;
		}> = [];

		const feeder = new StreamingAsrFeeder({
			transcriber,
			events: {
				onPartial: (u) => partials.push(u),
				onWords: (w) => words.push([...w]),
				onFinalTokens: (tokens, final) => {
					finalEvents.push({ tokens, final });
				},
			},
		});

		feeder.feedFrame(PCM_FRAME(160, 0));
		feeder.feedFrame(PCM_FRAME(160, 10));
		feeder.feedFrame(PCM_FRAME(160, 20));

		// LocalAgreement-2: "hi" is only committed once it has appeared at the
		// same position in two consecutive hypotheses ("hi", "hi there") — one
		// stabilized partial, no raw-hypothesis passthrough.
		expect(partials.map((p) => p.partial)).toEqual(["hi"]);
		expect(feeder.getLatestPartial()?.partial).toBe("hi");
		// "words" fires once, on the first COMMITTED word.
		expect(words).toEqual([["hi"]]);

		const final = await feeder.finalize();
		expect(final.partial).toBe("hi there friend");
		const finalEvent = finalEvents[0];
		if (!finalEvent) {
			throw new Error("Expected a final transcriber event.");
		}
		// `splitTranscriptToTokens` keeps the leading space attached to each
		// chunk after the first so `tokens.map(t => t.text).join("")` round-trips.
		expect(finalEvent.tokens.map((t) => t.text)).toEqual([
			"hi",
			" there",
			" friend",
		]);

		feeder.dispose();
		transcriber.dispose();
	});

	it("forwards already-stabilized partials without double-gating", async () => {
		const script: ScriptedStream = {
			partials: [{ partial: "" }, { partial: "hi" }, { partial: "hi there" }],
			final: { partial: "hi there friend" },
		};
		const { ffi } = scriptedFfi(script);
		const stabilized = new StabilizedStreamingTranscriber(
			new FfiStreamingTranscriber({ ffi, getContext: () => 1n }),
		);

		const partials: string[] = [];
		const words: string[][] = [];
		const feeder = new StreamingAsrFeeder({
			transcriber: stabilized,
			events: {
				onPartial: (u) => partials.push(u.partial),
				onWords: (w) => words.push([...w]),
			},
		});

		feeder.feedFrame(PCM_FRAME(160, 0));
		feeder.feedFrame(PCM_FRAME(160, 10));
		feeder.feedFrame(PCM_FRAME(160, 20));

		// One stabilization point: the wrapper committed "hi"; the feeder
		// forwards it as-is (no second LocalAgreement window of lag).
		expect(partials).toEqual(["hi"]);
		expect(words).toEqual([["hi"]]);

		await feeder.finalize();
		feeder.dispose();
		stabilized.dispose();
	});

	it("never emits a retracted word under random hypothesis churn (property)", () => {
		// Deterministic LCG so failures reproduce.
		let seed = 0xc0ffee;
		const rand = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0xffffffff;
		};
		const vocab = ["the", "cat", "cap", "sat", "sit", "on", "a", "mat", "map"];
		for (let trial = 0; trial < 50; trial++) {
			const gate = new WordAgreementGate();
			let surfaced: string[] = [];
			// A hypothesis stream that grows overall but churns its tail.
			let stable: string[] = [];
			for (let step = 0; step < 40; step++) {
				if (rand() < 0.6) {
					stable = [...stable, vocab[Math.floor(rand() * vocab.length)]];
				}
				const churnLen = Math.floor(rand() * 3);
				const churn = Array.from(
					{ length: churnLen },
					() => vocab[Math.floor(rand() * vocab.length)],
				);
				const hypothesis = [...stable, ...churn].join(" ");
				const update = gate.transform({ partial: hypothesis, isFinal: false });
				if (update === null) continue;
				const next =
					update.partial.length === 0 ? [] : update.partial.split(" ");
				// Monotonic committed prefix: every previously surfaced word is
				// still present at the same position.
				expect(next.length).toBeGreaterThanOrEqual(surfaced.length);
				expect(next.slice(0, surfaced.length)).toEqual(surfaced);
				surfaced = next;
			}
		}
	});

	it("drops feeds received after finalize()", async () => {
		const script: ScriptedStream = {
			partials: [{ partial: "a" }],
			final: { partial: "a" },
		};
		const { ffi, state } = scriptedFfi(script);
		const transcriber = new FfiStreamingTranscriber({
			ffi,
			getContext: () => 1n,
		});
		const feeder = new StreamingAsrFeeder({ transcriber });

		feeder.feedFrame(PCM_FRAME(160, 0));
		await feeder.finalize();

		feeder.feedFrame(PCM_FRAME(160, 100));
		feeder.feedFrame(PCM_FRAME(160, 200));
		// Only the pre-finalize feed reached the FFI.
		expect(state.feeds).toBe(1);

		feeder.dispose();
	});

	it("rejects a second finalize() call", async () => {
		const { ffi } = scriptedFfi({
			partials: [{ partial: "" }],
			final: { partial: "" },
		});
		const transcriber = new FfiStreamingTranscriber({
			ffi,
			getContext: () => 1n,
		});
		const feeder = new StreamingAsrFeeder({ transcriber });

		await feeder.finalize();
		await expect(feeder.finalize()).rejects.toThrow(/twice/i);
		feeder.dispose();
	});
});

/* ---- StabilizedStreamingTranscriber --------------------------------- */

describe("StabilizedStreamingTranscriber", () => {
	it("emits only committed-prefix partials and withholds raw-hypothesis words", async () => {
		const script: ScriptedStream = {
			// The tail word churns ("sa" → "cap" → "sat on") — only the agreed
			// prefix may surface.
			partials: [
				{ partial: "the cat sa" },
				{ partial: "the cat cap" },
				{ partial: "the cat sat on" },
			],
			final: { partial: "the cat sat on a mat", tokens: [1, 2, 3, 4, 5, 6] },
		};
		const { ffi } = scriptedFfi(script);
		const inner = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		const stabilized = new StabilizedStreamingTranscriber(inner);
		const events = collect(stabilized);

		for (let i = 0; i < 3; i++) stabilized.feed(PCM_FRAME(1600, i * 100));

		const partials = events
			.filter(
				(e): e is TranscriberEvent & { kind: "partial" } =>
					e.kind === "partial",
			)
			.map((e) => e.update.partial);
		// Window pairs: (sa,cap) agree on "the cat"; (cap,"sat on") agree on
		// "the cat" — no growth, suppressed.
		expect(partials).toEqual(["the cat"]);

		const wordEvents = events.filter(
			(e): e is TranscriberEvent & { kind: "words" } => e.kind === "words",
		);
		expect(wordEvents).toHaveLength(1);
		expect(wordEvents[0]?.words).toEqual(["the", "cat"]);

		// The final passes through unchanged, ids intact.
		const final = await stabilized.flush();
		expect(final.partial).toBe("the cat sat on a mat");
		expect(final.tokens).toEqual([1, 2, 3, 4, 5, 6]);
		const finalEvents = events.filter((e) => e.kind === "final");
		expect(finalEvents).toHaveLength(1);

		stabilized.dispose();
	});

	it("drops raw-hypothesis token ids from stabilized partials", () => {
		const gate = new WordAgreementGate();
		expect(
			gate.transform({
				partial: "hello there",
				isFinal: false,
				tokens: [7, 8],
			}),
		).toBeNull();
		const update = gate.transform({
			partial: "hello there friend",
			isFinal: false,
			tokens: [7, 8, 9],
		});
		expect(update?.partial).toBe("hello there");
		expect(update?.tokens).toBeUndefined();
	});

	it("resets the agreement window at segment boundaries (final)", async () => {
		const script: ScriptedStream = {
			partials: [{ partial: "alpha" }, { partial: "alpha beta" }],
			final: { partial: "alpha beta" },
		};
		const { ffi } = scriptedFfi(script);
		const inner = new FfiStreamingTranscriber({ ffi, getContext: () => 1n });
		const stabilized = new StabilizedStreamingTranscriber(inner);
		const events = collect(stabilized);

		stabilized.feed(PCM_FRAME(160, 0));
		stabilized.feed(PCM_FRAME(160, 10));
		await stabilized.flush();

		// Next segment gets a fresh window: a single hypothesis commits nothing.
		stabilized.feed(PCM_FRAME(160, 100));
		const partialsAfterFinal = events.filter(
			(e, i) =>
				e.kind === "partial" && i > events.findIndex((x) => x.kind === "final"),
		);
		expect(partialsAfterFinal).toHaveLength(0);

		stabilized.dispose();
	});
});

/* ---- ELIZA_VOICE_STREAMING_ASR flag ---------------------------------- */

describe("readStreamingAsrEnabledFromEnv", () => {
	it("defaults ON when unset", () => {
		expect(readStreamingAsrEnabledFromEnv({})).toBe(true);
	});

	it.each([
		"0",
		"false",
		"off",
		"no",
		"FALSE",
		" Off ",
	])("disables on %j", (raw) => {
		expect(
			readStreamingAsrEnabledFromEnv({ ELIZA_VOICE_STREAMING_ASR: raw }),
		).toBe(false);
	});

	it.each(["1", "true", "on", "yes"])("stays enabled on %j", (raw) => {
		expect(
			readStreamingAsrEnabledFromEnv({ ELIZA_VOICE_STREAMING_ASR: raw }),
		).toBe(true);
	});
});
