/** Unit tests for inference-capability helpers including the thermal-throttle decision. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	defaultsForNoBinding,
	probeCapabilities,
	thermalThrottleDecision,
} from "./inference-capabilities";

describe("thermalThrottleDecision", () => {
	it("does not throttle a cool device", () => {
		const d = thermalThrottleDecision({ thermalState: "nominal" });
		expect(d.throttleSpeculativeDecode).toBe(false);
		expect(d.reduceLoad).toBe(false);
	});

	it("throttles speculative decode at serious and sheds load at critical", () => {
		const serious = thermalThrottleDecision({ thermalState: "serious" });
		expect(serious.throttleSpeculativeDecode).toBe(true);
		expect(serious.reduceLoad).toBe(false);

		const critical = thermalThrottleDecision({ thermalState: "critical" });
		expect(critical.throttleSpeculativeDecode).toBe(true);
		expect(critical.reduceLoad).toBe(true);
	});

	it("throttles under low-power mode even when cool", () => {
		const d = thermalThrottleDecision({
			thermalState: "nominal",
			lowPowerMode: true,
		});
		expect(d.throttleSpeculativeDecode).toBe(true);
		expect(d.reduceLoad).toBe(false);
	});

	it("does not throttle on an unknown thermal state without a low-power signal", () => {
		const d = thermalThrottleDecision({ thermalState: "unknown" });
		expect(d.throttleSpeculativeDecode).toBe(false);
		expect(d.reduceLoad).toBe(false);
	});

	it("still honours low-power mode when thermal state is unknown", () => {
		const d = thermalThrottleDecision({
			thermalState: "unknown",
			lowPowerMode: true,
		});
		expect(d.throttleSpeculativeDecode).toBe(true);
	});
});

describe("probeCapabilities thermal gating (regression)", () => {
	const probes = {
		llmStreamSupported: () => true,
		ttsStreamSupported: () => false,
		mtpResident: () => true,
		mmprojResident: () => false,
		platform: () => "ios" as const,
	};

	it("keeps MTP on while cool but disables it under serious heat", () => {
		expect(
			probeCapabilities({ ...probes, thermalState: () => "fair" }).mtpSupported,
		).toBe(true);
		expect(
			probeCapabilities({ ...probes, thermalState: () => "serious" })
				.mtpSupported,
		).toBe(false);
	});

	it("defaultsForNoBinding reports a safe all-off struct", () => {
		const d = defaultsForNoBinding();
		expect(d.streamingLlm).toBe(false);
		expect(d.mtpSupported).toBe(false);
		expect(d.thermalState).toBe("nominal");
		expect(d.platform).toBe("unknown");
	});
});
