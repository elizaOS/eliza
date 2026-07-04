/** Unit tests for `collectLifecycleLoadRunChecks`, the model load/run lifecycle preflight checks. Deterministic. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { collectLifecycleLoadRunChecks } from "./lifecycle-loadrun";
import type { HardwareProbe, InstalledModel } from "./types";

const mocks = vi.hoisted(() => {
	const handle = {
		conversationId: "lifecycle-loadrun-eliza-1-4b",
		modelId: "eliza-1-4b",
		slotId: 0,
		closed: false,
		lastUsedMs: 0,
	};
	return {
		handle,
		listInstalledModels: vi.fn(),
		probeHardware: vi.fn(),
		deviceCapsFromProbe: vi.fn(),
		setActive: vi.fn(),
		clearActive: vi.fn(),
		hasLoadedModel: vi.fn(),
		openConversation: vi.fn(),
		generateInConversation: vi.fn(),
		closeConversation: vi.fn(),
	};
});

vi.mock("./registry", () => ({
	listInstalledModels: mocks.listInstalledModels,
}));

vi.mock("./hardware", () => ({
	probeHardware: mocks.probeHardware,
}));

vi.mock("./recommendation", () => ({
	deviceCapsFromProbe: mocks.deviceCapsFromProbe,
}));

vi.mock("./service", () => ({
	localInferenceService: {
		setActive: mocks.setActive,
		clearActive: mocks.clearActive,
	},
}));

vi.mock("./engine", () => ({
	localInferenceEngine: {
		hasLoadedModel: mocks.hasLoadedModel,
		openConversation: mocks.openConversation,
		generateInConversation: mocks.generateInConversation,
		closeConversation: mocks.closeConversation,
	},
}));

const hardware: HardwareProbe = {
	totalRamGb: 32,
	freeRamGb: 20,
	gpu: { backend: "metal", totalVramGb: 16, freeVramGb: 12 },
	cpuCores: 10,
	platform: "darwin",
	arch: "arm64",
	appleSilicon: true,
	recommendedBucket: "large",
	source: "os-fallback",
};

const installedModel: InstalledModel = {
	id: "eliza-1-4b",
	displayName: "eliza-1-4B",
	path: "/tmp/eliza-1-4b/text/eliza-1-4b-128k.gguf",
	sizeBytes: 1024,
	bundleRoot: "/tmp/eliza-1-4b",
	manifestPath: "/tmp/eliza-1-4b/eliza-1.manifest.json",
	installedAt: "2026-07-02T00:00:00.000Z",
	lastUsedAt: null,
	source: "eliza-download",
	bundleVerifiedAt: "2026-07-02T00:01:00.000Z",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handle.closed = false;
	mocks.listInstalledModels.mockResolvedValue([installedModel]);
	mocks.probeHardware.mockResolvedValue(hardware);
	mocks.deviceCapsFromProbe.mockReturnValue({
		recommendedBucket: "large",
		rationale: [],
		availableBackends: ["metal", "cpu"],
	});
	mocks.setActive.mockResolvedValue({ status: "ready" });
	mocks.clearActive.mockResolvedValue(undefined);
	mocks.hasLoadedModel.mockReturnValue(true);
	mocks.openConversation.mockReturnValue(mocks.handle);
	mocks.closeConversation.mockResolvedValue(undefined);
});

describe("collectLifecycleLoadRunChecks", () => {
	it("closes the conversation handle when generation throws", async () => {
		mocks.generateInConversation.mockRejectedValue(new Error("decode failed"));

		const checks = await collectLifecycleLoadRunChecks({ hardware });

		expect(checks["eliza-1-4b"]).toMatchObject({
			status: "fail",
			backend: "metal",
			detail: "load/run threw: decode failed",
		});
		expect(mocks.openConversation).toHaveBeenCalledWith({
			conversationId: "lifecycle-loadrun-eliza-1-4b",
			modelId: "eliza-1-4b",
		});
		expect(mocks.closeConversation).toHaveBeenCalledWith(mocks.handle);
		expect(mocks.clearActive).toHaveBeenCalledWith(null);
		expect(mocks.closeConversation.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.clearActive.mock.invocationCallOrder[0],
		);
	});
});
