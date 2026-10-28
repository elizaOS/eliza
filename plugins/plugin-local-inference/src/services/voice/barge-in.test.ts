import { describe, expect, it } from "vitest";
import { BargeInController } from "./barge-in";
import type { VadEvent, VadEventSource } from "./types";

/** Minimal VAD source: the test drives the events the detector would emit. */
function vadStub(): VadEventSource & { emit: (event: VadEvent) => void } {
	let listener: ((event: VadEvent) => void) | null = null;
	return {
		onVadEvent: (fn) => {
			listener = fn;
			return () => {
				listener = null;
			};
		},
		emit: (event) => listener?.(event),
	};
}

describe("BargeInController word-confirm window", () => {
	it("hard-stops when ASR words land inside the grace window opened by a blip", () => {
		const vad = vadStub();
		const controller = new BargeInController({ wordsGraceMs: 600 });
		controller.bindVad(vad);
		controller.setAgentSpeaking(true);
		const signals: string[] = [];
		controller.onSignal((signal) => signals.push(signal.type));

		// Audio-clock timestamps, as the VAD detector reports them.
		vad.emit({ type: "speech-start", timestampMs: 1_000, probability: 0.9 });
		vad.emit({
			type: "blip",
			timestampMs: 1_100,
			durationMs: 40,
			peakRms: 0.01,
		});
		expect(signals).toEqual(["pause-tts", "resume-tts"]);

		// The ASR sink reports its own clock (turn-controller passes Date.now()).
		// The words arrived inside the original grace window, so they are
		// authoritative and must promote the provisional pause into a hard stop.
		controller.onWordsDetected({
			wordCount: 2,
			partialText: "wait stop",
			timestampMs: Date.now(),
		});

		expect(signals).toEqual(["pause-tts", "resume-tts", "hard-stop"]);
	});
});
