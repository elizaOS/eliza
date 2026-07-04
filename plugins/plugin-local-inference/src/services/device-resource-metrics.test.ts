/** Unit tests for `DeviceResourceMetrics` RAM/CPU/thermal sampling. Deterministic. */
import { describe, expect, it } from "vitest";
import { DeviceResourceMetrics } from "./device-resource-metrics";

describe("DeviceResourceMetrics", () => {
	it("summarizes generation throughput and sampled device resources", () => {
		const metrics = new DeviceResourceMetrics({ leakGrowthMbThreshold: 100 });

		metrics.recordGeneration({
			prefillTokensPerSecond: 320,
			decodeTokensPerSecond: 160,
			combinedTokensPerSecond: 128,
			ttftMs: 200,
		});
		metrics.recordResourceSample({
			atMs: 0,
			residentMemoryMb: 1000,
			batteryLevelPct: 80,
			batteryChargeMicroAmpHours: 10_000,
			isCharging: false,
			thermalState: "nominal",
			lowPowerMode: false,
		});
		metrics.recordResourceSample({
			atMs: 1000,
			residentMemoryMb: 1050,
			batteryLevelPct: 79,
			batteryChargeMicroAmpHours: 9900,
			thermalState: "serious",
			lowPowerMode: true,
		});
		metrics.recordResourceSample({
			atMs: 2000,
			residentMemoryMb: 1125,
			batteryLevelPct: 78,
			batteryChargeMicroAmpHours: 9800,
			thermalState: "critical",
			lowPowerMode: false,
		});
		metrics.recordResourceSample({
			atMs: 3000,
			residentMemoryMb: 1205,
			batteryLevelPct: 77,
			batteryChargeMicroAmpHours: 9700,
			thermalState: "critical",
			lowPowerMode: false,
		});

		const summary = metrics.summary();

		expect(summary.generations).toBe(1);
		expect(summary.prefillTokensPerSecond.p50).toBe(320);
		expect(summary.decodeTokensPerSecond.p50).toBe(160);
		expect(summary.combinedTokensPerSecond.p50).toBe(128);
		expect(summary.ttftMs.p50).toBe(200);
		expect(summary.rss).toMatchObject({
			firstMb: 1000,
			lastMb: 1205,
			peakMb: 1205,
			steadyMb: 1165,
			growthMb: 205,
			leakSuspected: true,
		});
		expect(summary.battery).toMatchObject({
			firstPct: 80,
			lastPct: 77,
			drainPct: 3,
			energyMicroAmpHoursDelta: 300,
			durationMs: 3000,
			chargingObserved: false,
		});
		expect(summary.thermal).toMatchObject({
			initialState: "nominal",
			maxState: "critical",
			transitionCount: 2,
			fractionThrottled: 0.75,
		});
		expect(summary.lowPowerMode).toMatchObject({
			everEnabled: true,
			transitionCount: 2,
		});
	});

	it("keeps unmeasured quantities null instead of fabricating zeros", () => {
		const metrics = new DeviceResourceMetrics();

		metrics.recordGeneration({});
		metrics.recordResourceSample({ atMs: 0 });

		const summary = metrics.summary();

		expect(summary.generations).toBe(1);
		expect(summary.prefillTokensPerSecond.count).toBe(0);
		expect(summary.prefillTokensPerSecond.p50).toBeNull();
		expect(summary.rss.firstMb).toBeNull();
		expect(summary.battery.drainPct).toBeNull();
		expect(summary.thermal.fractionThrottled).toBeNull();
	});
});
