import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { classifyDeviceTier, type DeviceTierAssessment } from "./device-tier";
import type { HandlerRegistration } from "./handler-registry";
import { policyEngine } from "./routing-policy";
import type { HardwareProbe } from "./types";

const noopHandler: HandlerRegistration["handler"] = async (
	_runtime: IAgentRuntime,
	_params: Record<string, unknown>,
) => null;

function registration(provider: string, priority: number): HandlerRegistration {
	return {
		modelType: "TEXT_LARGE",
		provider,
		priority,
		registeredAt: "test",
		handler: noopHandler,
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

// A 4 GB Chromebook-class box → POOR tier, mode "cloud-only".
const weakDevice: DeviceTierAssessment = classifyDeviceTier({
	...baseProbe,
	totalRamGb: 4,
	freeRamGb: 1.5,
	cpuCores: 2,
});

describe("PolicyEngine — auto policy", () => {
	it("classifier sanity: strong device favours local, weak device does not", () => {
		expect(strongDevice.tier).toBe("MAX");
		expect(strongDevice.recommendedMode).toBe("local");
		expect(strongDevice.canRunLocalLm).toBe(true);
		expect(weakDevice.tier).toBe("POOR");
		expect(weakDevice.canRunLocalLm).toBe(false);
	});

	it("routes a strong device to the local provider", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "auto",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
			],
			selfProvider: "eliza-router",
			deviceTier: strongDevice,
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});

	it("routes a weak device to the highest-priority cloud provider", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "auto",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
				registration("elizacloud", 50),
			],
			selfProvider: "eliza-router",
			deviceTier: weakDevice,
		});
		expect(pick?.provider).toBe("elizacloud");
	});

	it("falls back to cloud when no device assessment is available", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "auto",
			preferredProvider: null,
			candidates: [
				registration("eliza-local-inference", -100),
				registration("anthropic", 0),
			],
			selfProvider: "eliza-router",
			deviceTier: null,
		});
		expect(pick?.provider).toBe("anthropic");
	});

	it("uses the only available provider even if it is local on a weak device", () => {
		const pick = policyEngine.pickProvider({
			modelType: "TEXT_LARGE",
			policy: "auto",
			preferredProvider: null,
			candidates: [registration("eliza-local-inference", -100)],
			selfProvider: "eliza-router",
			deviceTier: weakDevice,
		});
		expect(pick?.provider).toBe("eliza-local-inference");
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
			deviceTier: strongDevice,
		});
		expect(pick?.provider).toBe("eliza-local-inference");
	});
});
