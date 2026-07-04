/** Covers the `PolicyEngine` auto policy: static tier selection, live-signal demotion, and per-modality independence. Deterministic, injected signals. */
import { describe, expect, it } from "vitest";
import { classifyDeviceTier, type DeviceTierAssessment } from "./device-tier";
import type { HandlerRegistration } from "./handler-registry";
import type { LiveDeviceSignals } from "./live-signals";
import { assessVoiceModality, policyEngine } from "./routing-policy";
import type { AgentModelSlot, HardwareProbe } from "./types";

function registration(
	provider: string,
	priority: number,
	modelType = "TEXT_LARGE",
): HandlerRegistration {
	return {
		modelType,
		provider,
		priority,
		registeredAt: "test",
	};
}

const baseProbe: HardwareProbe = {
	totalRamGb: 16,
	freeRamGb: 8,
	gpu: null,
	cpuCores: 8,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "mid",
	source: "os-fallback",
};

// A CUDA workstation: 24 GB VRAM, plenty of free RAM → MAX tier, mode "local".
const strongDevice: DeviceTierAssessment = classifyDeviceTier({
	...baseProbe,
	totalRamGb: 64,
	freeRamGb: 48,
	gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
	cpuCores: 16,
});

// A 4 GB box → POOR tier, mode "cloud-only".
const weakDevice: DeviceTierAssessment = classifyDeviceTier({
	...baseProbe,
	totalRamGb: 4,
	freeRamGb: 1.5,
	cpuCores: 2,
});

// An OKAY desktop: enough to run a local LM but NOT the local voice stack.
// canRunLocalLm = true, canRunLocalVoice = false, recommendedMode = "local".
const okayDesktop: DeviceTierAssessment = classifyDeviceTier({
	...baseProbe,
	totalRamGb: 16,
	freeRamGb: 6,
	cpuCores: 8,
});

const NO_LIVE_DEMOTION: LiveDeviceSignals = {
	thermalState: "nominal",
	decodeTokensPerSecond: 40,
};

function pickAuto(args: {
	slot?: AgentModelSlot;
	modelType?: string;
	candidates: HandlerRegistration[];
	deviceTier?: DeviceTierAssessment | null;
	liveSignals?: LiveDeviceSignals | null;
}): HandlerRegistration | null {
	return policyEngine.pickProvider({
		modelType: args.modelType ?? "TEXT_LARGE",
		policy: "auto",
		preferredProvider: null,
		candidates: args.candidates,
		selfProvider: "eliza-router",
		slot: args.slot,
		deviceTier: args.deviceTier,
		liveSignals: args.liveSignals,
	});
}

describe("PolicyEngine — auto policy (static tier)", () => {
	it("classifier sanity: strong favours local, weak does not, OKAY desktop splits", () => {
		expect(strongDevice.tier).toBe("MAX");
		expect(strongDevice.recommendedMode).toBe("local");
		expect(strongDevice.canRunLocalLm).toBe(true);
		expect(strongDevice.canRunLocalVoice).toBe(true);

		expect(weakDevice.tier).toBe("POOR");
		expect(weakDevice.canRunLocalLm).toBe(false);

		expect(okayDesktop.tier).toBe("OKAY");
		expect(okayDesktop.recommendedMode).toBe("local");
		expect(okayDesktop.canRunLocalLm).toBe(true);
		expect(okayDesktop.canRunLocalVoice).toBe(false);
	});

	it("routes a strong device to the local provider", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
			],
			deviceTier: strongDevice,
			liveSignals: NO_LIVE_DEMOTION,
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});

	it("routes a weak device to the highest-priority cloud provider", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
				registration("elizacloud", 50),
			],
			deviceTier: weakDevice,
		});
		expect(pick?.provider).toBe("elizacloud");
	});

	it("falls back to cloud when no device assessment is available", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
			],
			deviceTier: null,
		});
		expect(pick?.provider).toBe("anthropic");
	});

	it("uses the only available provider even if it is local on a weak device", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: [registration("eliza-local-inference", -100)],
			deviceTier: weakDevice,
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});
});

describe("PolicyEngine — auto policy AC3 live-signal demotion", () => {
	const candidates = () => [
		registration("eliza-local-inference", -100),
		registration("anthropic", 0),
	];

	it("demotes a strong device to cloud under SERIOUS thermal throttling", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: candidates(),
			deviceTier: strongDevice,
			liveSignals: { thermalState: "serious", decodeTokensPerSecond: 40 },
		});
		expect(pick?.provider).toBe("anthropic");
	});

	it("demotes a strong device to cloud under CRITICAL thermal throttling", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: candidates(),
			deviceTier: strongDevice,
			liveSignals: { thermalState: "critical", decodeTokensPerSecond: 40 },
		});
		expect(pick?.provider).toBe("anthropic");
	});

	it("demotes a strong device to cloud when decode TPS is below budget", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: candidates(),
			deviceTier: strongDevice,
			liveSignals: { thermalState: "nominal", decodeTokensPerSecond: 2 },
		});
		expect(pick?.provider).toBe("anthropic");
	});

	it("does NOT demote on fair thermal + healthy TPS", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: candidates(),
			deviceTier: strongDevice,
			liveSignals: { thermalState: "fair", decodeTokensPerSecond: 40 },
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});

	it("does NOT demote when live signals are unmeasured (null)", () => {
		const pick = pickAuto({
			slot: "TEXT_LARGE",
			candidates: candidates(),
			deviceTier: strongDevice,
			liveSignals: { thermalState: null, decodeTokensPerSecond: null },
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});
});

describe("PolicyEngine — auto policy AC4 per-modality independence", () => {
	it("one OKAY-desktop assessment yields local TEXT_LARGE + cloud TEXT_TO_SPEECH", () => {
		const textPick = pickAuto({
			slot: "TEXT_LARGE",
			modelType: "TEXT_LARGE",
			candidates: [
				registration("eliza-local-inference", -100, "TEXT_LARGE"),
				registration("anthropic", 0, "TEXT_LARGE"),
			],
			deviceTier: okayDesktop,
			liveSignals: NO_LIVE_DEMOTION,
		});
		const voicePick = pickAuto({
			slot: "TEXT_TO_SPEECH",
			modelType: "TEXT_TO_SPEECH",
			candidates: [
				registration("eliza-local-inference", -100, "TEXT_TO_SPEECH"),
				registration("elizacloud", 50, "TEXT_TO_SPEECH"),
			],
			deviceTier: okayDesktop,
			liveSignals: NO_LIVE_DEMOTION,
		});

		// Same device, same instant — text stays on-device, voice goes to cloud.
		expect(textPick?.provider).toBe("eliza-local-inference");
		expect(voicePick?.provider).toBe("elizacloud");
	});

	it("TRANSCRIPTION (voice slot) also routes to cloud on OKAY desktop", () => {
		const pick = pickAuto({
			slot: "TRANSCRIPTION",
			modelType: "TRANSCRIPTION",
			candidates: [
				registration("eliza-local-inference", -100, "TRANSCRIPTION"),
				registration("elizacloud", 50, "TRANSCRIPTION"),
			],
			deviceTier: okayDesktop,
			liveSignals: NO_LIVE_DEMOTION,
		});
		expect(pick?.provider).toBe("elizacloud");
	});
});

describe("PolicyEngine — local-only / cloud-only (AC2)", () => {
	it("local-only always returns the local provider, never cloud", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "local-only",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 999),
			],
			selfProvider: "eliza-router",
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});

	it("local-only returns null when no local handler exists (no silent cloud fallback)", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "local-only",
			preferredProvider: null,
			candidates: [registration("anthropic", 0)],
			selfProvider: "eliza-router",
		});
		expect(pick).toBeNull();
	});

	it("cloud-only always returns a cloud provider, never local", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "cloud-only",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", 999),
				registration("anthropic", 0),
			],
			selfProvider: "eliza-router",
		});
		expect(pick?.provider).toBe("anthropic");
	});

	it("cloud-only returns null when only local handlers exist", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "cloud-only",
			preferredProvider: null,
			candidates: [registration("eliza-local-inference", 0)],
			selfProvider: "eliza-router",
		});
		expect(pick).toBeNull();
	});
});

describe("PolicyEngine — prefer-local capability soft-hint", () => {
	it("keeps local-first when no assessment is provided", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "prefer-local",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
			],
			selfProvider: "eliza-router",
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});

	it("demotes to cloud on a POOR device that cannot run a local LM", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "prefer-local",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
			],
			selfProvider: "eliza-router",
			slot: "TEXT_LARGE",
			deviceTier: weakDevice,
		});
		expect(pick?.provider).toBe("anthropic");
	});

	it("still prefers local on a strong device", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "prefer-local",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
			],
			selfProvider: "eliza-router",
			slot: "TEXT_LARGE",
			deviceTier: strongDevice,
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});
});

describe("assessVoiceModality (#12253 voice-modality visibility)", () => {
	it("is viable on a MAX-tier device that can run the local voice stack", () => {
		const result = assessVoiceModality(strongDevice);
		expect(result.viable).toBe(true);
		expect(result.reason).toBe("device-can-run-local-voice");
	});

	it("is not viable on a tier that cannot run local voice, with a reason", () => {
		expect(okayDesktop.canRunLocalVoice).toBe(false);
		const result = assessVoiceModality(okayDesktop);
		expect(result.viable).toBe(false);
		expect(result.reason).toContain("cannot-run-local-voice");
		expect(result.reason).toContain(okayDesktop.tier.toLowerCase());
	});

	it("is not viable with an explicit reason when the tier is unknown", () => {
		const result = assessVoiceModality(null);
		expect(result.viable).toBe(false);
		expect(result.reason).toBe("device-tier-unknown");
	});
});
