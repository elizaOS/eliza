import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMock = vi.hoisted(() => {
	let active = {
		modelId: null as string | null,
		loadedAt: null as string | null,
		status: "idle" as "idle" | "loading" | "ready" | "error",
		loadedContextSize: null as number | null,
		loadedCacheTypeK: null as string | null,
		loadedCacheTypeV: null as string | null,
		loadedGpuLayers: null as number | null,
	};
	return {
		getActive: () => active,
		setActive: (next: typeof active) => {
			active = next;
		},
	};
});

vi.mock("./services/service.ts", () => ({
	localInferenceService: {
		getActive: serviceMock.getActive,
	},
}));

vi.mock("./services/service.js", () => ({
	localInferenceService: {
		getActive: serviceMock.getActive,
	},
}));

vi.mock("@elizaos/plugin-capacitor-bridge", () => ({
	getMobileDeviceBridgeStatus: () => ({
		enabled: false,
		connected: false,
		devices: [],
	}),
	loadMobileDeviceBridgeModel: vi.fn(),
	unloadMobileDeviceBridgeModel: vi.fn(),
}));

import {
	getLocalInferenceActiveModelId,
	getLocalInferenceActiveSnapshot,
	getLocalInferenceChatStatus,
} from "./local-inference-routes.js";

describe("local inference chat status", () => {
	beforeEach(() => {
		serviceMock.setActive({
			modelId: null,
			loadedAt: null,
			status: "idle",
			loadedContextSize: null,
			loadedCacheTypeK: null,
			loadedCacheTypeV: null,
			loadedGpuLayers: null,
		});
	});

	it("uses the desktop active-model service state for chat status", async () => {
		serviceMock.setActive({
			modelId: "eliza-1-0_8b",
			loadedAt: "2026-05-16T02:22:23.512Z",
			status: "ready",
			loadedContextSize: 131_072,
			loadedCacheTypeK: null,
			loadedCacheTypeV: null,
			loadedGpuLayers: 99,
		});

		await expect(getLocalInferenceActiveSnapshot()).resolves.toMatchObject({
			modelId: "eliza-1-0_8b",
			status: "ready",
			loadedContextSize: 131_072,
			loadedGpuLayers: 99,
		});
		expect(getLocalInferenceActiveModelId()).toBe("eliza-1-0_8b");

		const status = await getLocalInferenceChatStatus("status");
		expect(status.localInference).toMatchObject({
			intent: "status",
			status: "ready",
			modelId: "eliza-1-0_8b",
			activeModelId: "eliza-1-0_8b",
			provider: "eliza-local-inference",
		});
		expect(status.text).toContain("Model: eliza-1-0_8b.");
		expect(status.text).not.toMatch(/none is loaded|waiting to be activated/i);
	});
});
