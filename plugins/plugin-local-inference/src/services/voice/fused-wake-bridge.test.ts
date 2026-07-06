/**
 * Producer-side fused-wake bridge (#10351).
 *
 * Drives the real {@link OpenWakeWordDetector} (the same class the live voice
 * loop builds around `libwakeword`) with a deterministic scripted model and
 * asserts that {@link bridgeDetectorToFusedWake} turns each native firing into
 * exactly one `head-fired` {@link FusedWakeEventDetail} carrying the firing
 * confidence. This is the CI-deterministic half of the bridge proof; the real
 * `libwakeword` + GGUF + PCM end-to-end run is
 * `test-results/evidence/10351-fused-wake-bridge/validate-fused-wake-e2e.mjs`.
 */

import { describe, expect, it } from "vitest";
import {
	bridgeDetectorToFusedWake,
	type FusedWakeEventDetail,
} from "./fused-wake-bridge";
import { OpenWakeWordDetector, type WakeWordModel } from "./wake-word";

const FRAME = 1280; // 80 ms @ 16 kHz — one openWakeWord step.

/** Deterministic model: replays a scripted probability per frame. */
class ScriptedWakeWordModel implements WakeWordModel {
	readonly frameSamples = FRAME;
	readonly sampleRate = 16_000;
	private idx = 0;
	constructor(private readonly probs: readonly number[]) {}
	async scoreFrame(frame: Float32Array): Promise<number> {
		expect(frame.length).toBe(FRAME);
		const p = this.probs[this.idx] ?? this.probs[this.probs.length - 1] ?? 0;
		this.idx++;
		return p;
	}
	reset(): void {
		this.idx = 0;
	}
}

function zeroFrame(): Float32Array {
	return new Float32Array(FRAME);
}

describe("bridgeDetectorToFusedWake", () => {
	it("emits one head-fired fused-wake event per native firing, with the firing confidence", async () => {
		const events: FusedWakeEventDetail[] = [];
		const det = new OpenWakeWordDetector({
			model: new ScriptedWakeWordModel([0.1, 0.2, 0.9, 0.95, 0.91, 0.1]),
			config: { threshold: 0.5, minActivationFrames: 3, refractoryFrames: 10 },
			onWake: bridgeDetectorToFusedWake((e) => events.push(e)),
		});
		for (let i = 0; i < 6; i++) await det.pushFrame(zeroFrame());
		expect(events).toHaveLength(1);
		expect(events[0].stage).toBe("head-fired");
		// Confidence is the probability that crossed threshold on the firing frame
		// (the 3rd consecutive ≥-threshold frame → script index 4 → 0.91).
		expect(events[0].confidence).toBeCloseTo(0.91, 5);
		expect(events[0].transcript).toBeUndefined();
	});

	it("debounces a sustained detection into a single event during the refractory window", async () => {
		const events: FusedWakeEventDetail[] = [];
		const det = new OpenWakeWordDetector({
			model: new ScriptedWakeWordModel([0.9, 0.9, 0.9, 0.9, 0.9]),
			config: { threshold: 0.5, minActivationFrames: 2, refractoryFrames: 25 },
			onWake: bridgeDetectorToFusedWake((e) => events.push(e)),
		});
		for (let i = 0; i < 5; i++) await det.pushFrame(zeroFrame());
		expect(events).toHaveLength(1);
	});

	it("re-arms and emits again after the refractory window elapses", async () => {
		const events: FusedWakeEventDetail[] = [];
		const det = new OpenWakeWordDetector({
			model: new ScriptedWakeWordModel([0.9, 0.1, 0.1, 0.9]),
			config: { threshold: 0.5, minActivationFrames: 1, refractoryFrames: 2 },
			onWake: bridgeDetectorToFusedWake((e) => events.push(e)),
		});
		for (let i = 0; i < 4; i++) await det.pushFrame(zeroFrame());
		expect(events).toHaveLength(2);
		expect(events.every((e) => e.stage === "head-fired")).toBe(true);
	});

	it("never emits when no frame crosses threshold", async () => {
		const events: FusedWakeEventDetail[] = [];
		const det = new OpenWakeWordDetector({
			model: new ScriptedWakeWordModel([0.1, 0.2, 0.3, 0.4, 0.49]),
			config: { threshold: 0.5, minActivationFrames: 1 },
			onWake: bridgeDetectorToFusedWake((e) => events.push(e)),
		});
		for (let i = 0; i < 5; i++) await det.pushFrame(zeroFrame());
		expect(events).toHaveLength(0);
	});
});
