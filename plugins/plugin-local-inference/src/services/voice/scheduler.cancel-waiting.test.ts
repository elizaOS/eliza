import { describe, expect, it } from "vitest";
import { VoiceScheduler } from "./scheduler.js";
import type { SpeakerPreset, TtsBackend } from "./types.js";

function preset(): SpeakerPreset {
	return {
		voiceId: "test-voice",
		embedding: new Float32Array(4),
		bytes: new Uint8Array(4),
	};
}

async function until(predicate: () => boolean): Promise<void> {
	for (let tick = 0; tick < 500 && !predicate(); tick += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	if (!predicate()) throw new Error("condition was not reached");
}

/**
 * A phrase waiting for an in-flight slot belongs to the turn being cancelled
 * as much as the phrases already synthesizing. After a barge-in or a pending
 * TTS cancel it must not take the slot, be synthesized, or reach the sink.
 */
describe("VoiceScheduler cancels a phrase waiting for a slot", () => {
	for (const cancel of ["barge-in", "cancelPendingTts"] as const) {
		it(`drops the waiting phrase on ${cancel}`, async () => {
			const gates: Array<() => void> = [];
			const synthesized: string[] = [];
			const played: string[] = [];
			const backend: TtsBackend = {
				async synthesize({ phrase }) {
					synthesized.push(phrase.text);
					await new Promise<void>((resolve) => gates.push(resolve));
					return {
						phraseId: phrase.id,
						fromIndex: phrase.fromIndex,
						toIndex: phrase.toIndex,
						pcm: new Float32Array(8),
						sampleRate: 24_000,
					};
				},
			};
			const scheduler = new VoiceScheduler(
				{
					chunkerConfig: {},
					preset: preset(),
					ringBufferCapacity: 4_096,
					sampleRate: 24_000,
					maxInFlightPhrases: 1,
					streamingTtsActive: false,
				},
				{
					backend,
					onAudio: (chunk) => {
						played.push(String(chunk.phraseId));
					},
				},
			);

			// "alpha" holds the only slot; "bravo" waits for it.
			await scheduler.accept({ index: 0, text: "alpha" });
			await scheduler.flushPending();
			await until(() => gates.length === 1);
			await scheduler.accept({ index: 1, text: "bravo" });
			const waiting = scheduler.flushPending();

			// The user interrupts while "bravo" is still waiting.
			if (cancel === "barge-in") scheduler.bargeIn.hardStop();
			else scheduler.cancelPendingTts();

			// The slot frees: the interrupted turn's waiting phrase must not use it.
			gates[0]?.();
			await waiting;
			await new Promise((resolve) => setTimeout(resolve, 5));
			for (const release of gates.slice(1)) release();
			await scheduler.waitIdle();

			expect(synthesized).toEqual(["alpha"]);
			expect(played).toEqual([]);
		});
	}
});
