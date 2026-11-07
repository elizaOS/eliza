import { describe, expect, it } from "vitest";
import { PhraseChunker } from "./phrase-chunker.js";
import { VoiceScheduler } from "./scheduler.js";
import type { SpeakerPreset, TtsBackend } from "./types.js";

const BUDGETS = { maxAccumulationMs: 700, firstPhraseMaxAccumulationMs: 350 };

function chunkerAt(clock: { now: number }): PhraseChunker {
	return new PhraseChunker(BUDGETS, null, () => clock.now);
}

function preset(): SpeakerPreset {
	return {
		voiceId: "test-voice",
		embedding: new Float32Array(4),
		bytes: new Uint8Array(4),
	};
}

const backend: TtsBackend = {
	async synthesize({ phrase }) {
		return {
			phraseId: phrase.id,
			fromIndex: phrase.fromIndex,
			toIndex: phrase.toIndex,
			pcm: new Float32Array(16),
			sampleRate: 24_000,
		};
	},
};

/**
 * The shorter first-phrase budget is documented as applying to "the first
 * phrase of each reply". A voice session reuses one scheduler, and the end of
 * a reply reaches the chunker as `flushPending()` (`EngineVoiceBridge.settle`
 * → `VoiceScheduler.flushPending`), so that call must re-arm the budget.
 */
describe("PhraseChunker first-phrase budget", () => {
	it("re-arms the first-phrase budget after flushPending flushes a tail", () => {
		const clock = { now: 0 };
		const chunker = chunkerAt(clock);
		chunker.push({ index: 0, text: "Hello", acceptedAt: 0 });
		expect(chunker.flushPending()?.text).toBe("Hello");

		clock.now = 10_000;
		chunker.push({ index: 0, text: "Hi", acceptedAt: clock.now });
		clock.now += 400;
		expect(chunker.flushIfTimeBudgetExceeded()?.text).toBe("Hi");
	});

	it("re-arms the first-phrase budget when the reply ended on punctuation", () => {
		const clock = { now: 0 };
		const chunker = chunkerAt(clock);
		expect(chunker.push({ index: 0, text: "Sure.", acceptedAt: 0 })?.text).toBe(
			"Sure.",
		);
		expect(chunker.flushPending()).toBeNull();

		clock.now = 10_000;
		chunker.push({ index: 0, text: "Okay", acceptedAt: clock.now });
		expect(chunker.msUntilTimeBudget()).toBe(350);
	});

	it("keeps the full budget for later phrases of the same reply", () => {
		const clock = { now: 0 };
		const chunker = chunkerAt(clock);
		chunker.push({ index: 0, text: "Well,", acceptedAt: 0 });
		chunker.push({ index: 1, text: " then", acceptedAt: 0 });
		expect(chunker.msUntilTimeBudget()).toBe(700);
	});

	it("gives the next reply's first phrase the short budget through the scheduler", async () => {
		const scheduler = new VoiceScheduler(
			{
				chunkerConfig: BUDGETS,
				preset: preset(),
				ringBufferCapacity: 4096,
				sampleRate: 24_000,
				streamingTtsActive: false,
			},
			{ backend },
		);
		try {
			await scheduler.accept({ index: 0, text: "Well" });
			expect(scheduler.chunker.msUntilTimeBudget()).toBeLessThanOrEqual(350);
			await scheduler.accept({ index: 1, text: " sure." });
			await scheduler.flushPending();
			await scheduler.waitIdle();

			await scheduler.accept({ index: 0, text: "Okay" });
			expect(scheduler.chunker.msUntilTimeBudget()).toBeLessThanOrEqual(350);
		} finally {
			scheduler.cancelPendingTts();
		}
	});
});
