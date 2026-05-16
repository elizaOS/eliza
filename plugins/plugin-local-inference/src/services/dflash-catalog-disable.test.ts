import { describe, expect, it, vi } from "vitest";
import { DflashLlamaServer } from "./dflash-server";

vi.mock("./backend", () => ({
	gpuLayersForKvOffload: () => null,
}));

vi.mock("./catalog", () => ({
	ELIZA_1_PLACEHOLDER_IDS: new Set<string>(),
	ELIZA_1_TIER_IDS: [],
	MODEL_CATALOG: [],
	findCatalogModel: vi.fn(() => undefined),
}));

vi.mock("./cache-bridge", () => ({
	DEFAULT_CACHE_TTLS: { short: 1, long: 1, extended: 1 },
	buildModelHash: () => "hash",
	deriveSlotId: () => 0,
	evictExpired: vi.fn(() => Promise.resolve()),
	readCacheStats: vi.fn(() => []),
	slotCacheFileName: () => "slot.json",
	slotSavePath: () => "/tmp/dflash-slots",
}));

vi.mock("./dflash-event-schema", () => ({
	parseDflashFieldFromSseChunk: vi.fn(() => null),
}));

vi.mock("./dflash-metrics-collector", () => ({
	DflashMetricsCollector: class {},
	dflashTurnHistory: [],
}));

vi.mock("./dflash-verify-event", () => ({
	parseDflashVerifyEventsFromSseChunk: vi.fn(() => []),
}));

vi.mock("./hardware", () => ({
	probeHardware: vi.fn(() => ({ totalRamMb: 0, appleSilicon: false })),
}));

vi.mock("./inference-telemetry", () => ({
	inferenceTelemetry: {
		record: vi.fn(),
	},
}));

vi.mock("./kv-spill", () => ({
	estimateQuantizedKvBytesPerToken: () => 0,
	KV_SPILL_MIN_CONTEXT: 0,
	planKvSpill: vi.fn(() => null),
	residentKvBudgetFromRamBudget: () => 0,
	restoreClassForHardware: () => null,
}));

vi.mock("./llama-server-metrics", () => ({
	diffSnapshots: vi.fn(() => null),
	fetchMetricsSnapshot: vi.fn(() => null),
}));

vi.mock("./manifest", () => ({
	parseManifestOrThrow: vi.fn(() => null),
	validateManifest: vi.fn(() => null),
}));

vi.mock("./ram-budget", () => ({
	ramHeadroomReserveMb: () => 0,
	resolveRamBudget: () => ({ minMb: 0, recommendedMb: 0 }),
}));

vi.mock("./registry", () => ({
	listInstalledModels: vi.fn(),
}));

vi.mock("./structured-output", () => ({
	grammarRequestFields: [],
	prefillPlanRequestFields: [],
	repairStructuredOutput: vi.fn(),
	resolveGuidedDecodeForParams: vi.fn(() => null),
	StructuredOutputRepairStream: class {},
	spanSamplerPlanRequestFields: [],
}));

describe("DflashLlamaServer catalog disable reason", () => {
	it("launches target-only when the catalog disables DFlash", async () => {
		const registry = await import("./registry");
		vi.mocked(registry.listInstalledModels).mockResolvedValue([
			{
				id: "target-model",
				displayName: "Target model",
				path: "/models/target.gguf",
				sizeBytes: 1,
				installedAt: "2026-05-16T00:00:00.000Z",
				lastUsedAt: null,
				source: "eliza-download",
			},
			{
				id: "drafter-model",
				displayName: "Drafter model",
				path: "/models/drafter.gguf",
				sizeBytes: 1,
				installedAt: "2026-05-16T00:00:00.000Z",
				lastUsedAt: null,
				source: "eliza-download",
				runtimeRole: "dflash-drafter",
				companionFor: "target-model",
			},
		] as never);

		const startSpy = vi
			.spyOn(DflashLlamaServer.prototype, "start")
			.mockResolvedValue(undefined);

		try {
			const server = new DflashLlamaServer();
			await server.load({
				modelId: "target-model",
				modelPath: "/models/target.gguf",
				catalog: {
					id: "target-model",
					displayName: "Target model",
					hfRepo: "example/repo",
					ggufFile: "/models/target.gguf",
					params: "2B",
					quant: "q4",
					sizeGb: 1,
					minRamGb: 1,
					category: "chat",
					bucket: "small",
					blurb: "Target model",
					runtime: {
						dflash: {
							drafterModelId: "drafter-model",
							specType: "dflash",
							disabledReason:
								"Pending hardware validation for M-RoPE speculative decoding; see elizaOS/eliza#7631.",
							contextSize: 128,
							draftContextSize: 64,
							draftMin: 2,
							draftMax: 4,
							gpuLayers: "auto",
							draftGpuLayers: "auto",
							disableThinking: false,
						},
					},
				} as never,
			} as never);

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(startSpy.mock.calls[0]?.[0]).toMatchObject({
				targetModelPath: "/models/target.gguf",
				drafterModelPath: "/models/drafter.gguf",
				disableDrafter: true,
				disabledDrafterReason:
					"Pending hardware validation for M-RoPE speculative decoding; see elizaOS/eliza#7631.",
			});
		} finally {
			startSpy.mockRestore();
		}
	});
});
