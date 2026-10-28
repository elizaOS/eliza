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
 * The in-flight cap is a memory bound: at most `maxInFlightPhrases` syntheses
 * may run at once. Two dispatches that both wait for the same finishing phrase
 * must not both start, or the bound is exceeded exactly when the queue is
 * longest.
 */
describe("VoiceScheduler in-flight cap", () => {
	it("holds the cap when two dispatches wait for the same slot", async () => {
		const gates: Array<() => void> = [];
		let active = 0;
		let peak = 0;
		const backend: TtsBackend = {
			async synthesize() {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise<void>((resolve) => gates.push(resolve));
				active -= 1;
				return {
					phraseId: 0,
					fromIndex: 0,
					toIndex: 0,
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
			{ backend },
		);

		// The first phrase takes the only slot and stays in synthesis.
		await scheduler.accept({ index: 0, text: "alpha" });
		await scheduler.flushPending();
		await until(() => gates.length === 1);

		// Two more phrases arrive while that slot is full. Both wait for the
		// same finishing phrase.
		await scheduler.accept({ index: 1, text: "bravo" });
		const second = scheduler.flushPending();
		await scheduler.accept({ index: 2, text: "charlie" });
		const third = scheduler.flushPending();

		gates[0]?.();
		await second;
		await until(() => gates.length === 2);
		gates[1]?.();
		await third;

		expect(peak).toBe(1);

		for (const release of gates.slice(2)) release();
		await scheduler.waitIdle();
	});
});
