import { afterEach, describe, expect, it } from "vitest";
import {
	type LiveDeviceSignals,
	liveSignalsDemoteLocal,
	MIN_DECODE_TPS_BUDGET,
	readLiveDeviceSignals,
	setLiveDeviceSignalsSource,
} from "./live-signals";

afterEach(() => {
	setLiveDeviceSignalsSource(null);
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
