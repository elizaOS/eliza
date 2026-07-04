/** Covers live device-signal reads (decode-token estimation, local demotion on pressure) feeding the routing policy. Deterministic, injected signal source. */
import { afterEach, describe, expect, it } from "vitest";
import { inferenceTelemetry } from "./inference-telemetry";
import {
	estimateDecodeTokens,
	type LiveDeviceSignals,
	liveSignalsDemoteLocal,
	MIN_DECODE_TPS_BUDGET,
	readLiveDeviceSignals,
	recordDecodeThroughput,
	setLiveDeviceSignalsSource,
} from "./live-signals";

afterEach(() => {
	setLiveDeviceSignalsSource(null);
	inferenceTelemetry.reset();
});

const signals = (over: Partial<LiveDeviceSignals>): LiveDeviceSignals => ({
	thermalState: null,
	decodeTokensPerSecond: null,
	...over,
});

describe("liveSignalsDemoteLocal", () => {
	it("demotes on serious thermal", () => {
		expect(liveSignalsDemoteLocal(signals({ thermalState: "serious" }))).toBe(
			true,
		);
	});

	it("demotes on critical thermal", () => {
		expect(liveSignalsDemoteLocal(signals({ thermalState: "critical" }))).toBe(
			true,
		);
	});

	it("does not demote on nominal / fair thermal", () => {
		expect(liveSignalsDemoteLocal(signals({ thermalState: "nominal" }))).toBe(
			false,
		);
		expect(liveSignalsDemoteLocal(signals({ thermalState: "fair" }))).toBe(
			false,
		);
	});

	it("demotes when decode TPS is below budget", () => {
		expect(
			liveSignalsDemoteLocal(
				signals({ decodeTokensPerSecond: MIN_DECODE_TPS_BUDGET - 1 }),
			),
		).toBe(true);
	});

	it("does not demote at or above the TPS budget", () => {
		expect(
			liveSignalsDemoteLocal(
				signals({ decodeTokensPerSecond: MIN_DECODE_TPS_BUDGET }),
			),
		).toBe(false);
		expect(
			liveSignalsDemoteLocal(signals({ decodeTokensPerSecond: 100 })),
		).toBe(false);
	});

	it("does not demote when both signals are unmeasured (null)", () => {
		expect(liveSignalsDemoteLocal(signals({}))).toBe(false);
	});
});

describe("readLiveDeviceSignals source injection", () => {
	it("returns whatever the injected source provides", () => {
		setLiveDeviceSignalsSource(() =>
			signals({ thermalState: "serious", decodeTokensPerSecond: 3 }),
		);
		const out = readLiveDeviceSignals();
		expect(out.thermalState).toBe("serious");
		expect(out.decodeTokensPerSecond).toBe(3);
	});

	it("restores the default source when set to null", () => {
		setLiveDeviceSignalsSource(() =>
			signals({ thermalState: "critical", decodeTokensPerSecond: 1 }),
		);
		setLiveDeviceSignalsSource(null);
		// Default source reads the (empty, in test) device bridge + telemetry:
		// no device connected and no decode samples → both null.
		const out = readLiveDeviceSignals();
		expect(out.thermalState).toBeNull();
		expect(out.decodeTokensPerSecond).toBeNull();
	});
});

describe("estimateDecodeTokens", () => {
	it("approximates ~4 characters per token", () => {
		expect(estimateDecodeTokens("")).toBe(0);
		expect(estimateDecodeTokens("abcd")).toBe(1);
		expect(estimateDecodeTokens("a".repeat(40))).toBe(10);
	});
});

describe("recordDecodeThroughput → default source → demotion (end-to-end)", () => {
	it("a sub-budget generation makes the default source demote local", () => {
		// 8 tokens in 2 s = 4 tok/s, below the 6 tok/s budget.
		recordDecodeThroughput({ tokens: 8, elapsedMs: 2000 });

		const out = readLiveDeviceSignals();
		expect(out.decodeTokensPerSecond).toBeLessThan(MIN_DECODE_TPS_BUDGET);
		expect(out.decodeTokensPerSecond).toBeCloseTo(4, 5);
		expect(liveSignalsDemoteLocal(out)).toBe(true);
	});

	it("a healthy generation does not demote local", () => {
		// 100 tokens in 1 s = 100 tok/s, comfortably above budget.
		recordDecodeThroughput({ tokens: 100, elapsedMs: 1000 });

		const out = readLiveDeviceSignals();
		expect(out.decodeTokensPerSecond).toBeGreaterThanOrEqual(
			MIN_DECODE_TPS_BUDGET,
		);
		expect(liveSignalsDemoteLocal(out)).toBe(false);
	});

	it("drops noise samples so the signal stays null", () => {
		recordDecodeThroughput({ tokens: 2, elapsedMs: 1000 }); // too few tokens
		recordDecodeThroughput({ tokens: 50, elapsedMs: 0 }); // clock didn't advance
		recordDecodeThroughput({ tokens: 50, elapsedMs: -10 }); // negative span

		const out = readLiveDeviceSignals();
		expect(out.decodeTokensPerSecond).toBeNull();
		expect(liveSignalsDemoteLocal(out)).toBe(false);
	});
});
