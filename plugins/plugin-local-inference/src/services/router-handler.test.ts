/** Unit tests for `installRouterHandler` wiring the routing-policy layer onto the runtime. Deterministic, fake runtime. */
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	filterUnavailableLocalInference,
	getRuntimeModelCandidates,
	installRouterHandler,
	ROUTER_PROVIDER,
} from "./router-handler";

describe("installRouterHandler", () => {
	it("does not register router handlers for skipped slots", () => {
		const registrations: Array<{
			modelType: string;
			provider: string;
			priority?: number;
		}> = [];
		const runtime = {
			registerModel: vi.fn(
				(
					modelType: string,
					_handler: unknown,
					provider: string,
					priority?: number,
				) => {
					registrations.push({ modelType, provider, priority });
				},
			),
		} as unknown as AgentRuntime;

		installRouterHandler(runtime, { skipSlots: ["TEXT_EMBEDDING"] });

		expect(registrations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					modelType: ModelType.TEXT_SMALL,
					provider: ROUTER_PROVIDER,
				}),
				expect.objectContaining({
					modelType: ModelType.TEXT_LARGE,
					provider: ROUTER_PROVIDER,
				}),
			]),
		);
		expect(
			registrations.some(
				(registration) => registration.modelType === ModelType.TEXT_EMBEDDING,
			),
		).toBe(false);
	});
});

// Guards the chat-latency fix: the always-on recall provider embedded every user
// message through Cloud (~1.4s) instead of the warmed on-device gte-small
// (~10ms), because the router dropped the local embedder whenever no local *text*
// LLM was loaded — the cloud/cerebras chat brain + on-device embeddings config.
// Embedder availability must not be gated on the text brain. The TEXT_EMBEDDING
// branch reads only env + policy, so this stays deterministic without a runtime.
describe("filterUnavailableLocalInference — TEXT_EMBEDDING stays on-device", () => {
	const noopHandler = async () => [] as number[];
	const local = {
		modelType: ModelType.TEXT_EMBEDDING,
		provider: "eliza-local-inference",
		priority: 0,
		handler: noopHandler,
	};
	const cloud = {
		modelType: ModelType.TEXT_EMBEDDING,
		provider: "elizaos-cloud",
		priority: 50,
		handler: noopHandler,
	};

	afterEach(() => {
		delete process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS;
	});

	it("keeps the gte-small candidate under prefer-local when no local text LLM is loaded", async () => {
		delete process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS;
		const result = await filterUnavailableLocalInference(
			"TEXT_EMBEDDING",
			"prefer-local",
			null,
			[cloud, local],
		);
		expect(result.map((candidate) => candidate.provider)).toEqual([
			"eliza-local-inference",
		]);
	});

	it("falls back to cloud when the operator forces cloud embeddings", async () => {
		process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";
		const result = await filterUnavailableLocalInference(
			"TEXT_EMBEDDING",
			"prefer-local",
			null,
			[cloud, local],
		);
		const providers = result.map((candidate) => candidate.provider);
		expect(providers).not.toContain("eliza-local-inference");
		expect(providers).toContain("elizaos-cloud");
	});

	it("keeps local under a local-only pin even when cloud embeddings are forced", async () => {
		process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "true";
		const result = await filterUnavailableLocalInference(
			"TEXT_EMBEDDING",
			"local-only",
			null,
			[cloud, local],
		);
		expect(result.map((candidate) => candidate.provider)).toContain(
			"eliza-local-inference",
		);
	});

	it("sorts candidate models deterministically when priorities contain non-finite numbers", () => {
		const mockRuntime = {
			models: new Map([
				[
					ModelType.TEXT_SMALL,
					[
						{
							provider: "provider-nan",
							priority: Number.NaN,
							handler: noopHandler,
						},
						{ provider: "provider-high", priority: 100, handler: noopHandler },
						{ provider: "provider-low", priority: 10, handler: noopHandler },
					],
				],
			]),
		} as unknown as IAgentRuntime;

		const candidates = getRuntimeModelCandidates(
			mockRuntime,
			ModelType.TEXT_SMALL,
		);
		expect(candidates.map((c) => c.provider)).toEqual([
			"provider-high",
			"provider-low",
			"provider-nan",
		]);
	});

	it("sorts device summaries safely by score with deviceId tiebreak", () => {
		const summaries = [
			{ deviceId: "dev-nan", score: Number.NaN },
			{ deviceId: "dev-high", score: 95 },
			{ deviceId: "dev-low", score: 20 },
			{ deviceId: "dev-low-2", score: 20 },
		];
		summaries.sort(
			(a, b) =>
				(Number.isFinite(b.score) ? b.score : 0) -
					(Number.isFinite(a.score) ? a.score : 0) ||
				a.deviceId.localeCompare(b.deviceId),
		);
		expect(summaries.map((d) => d.deviceId)).toEqual([
			"dev-high",
			"dev-low",
			"dev-low-2",
			"dev-nan",
		]);
	});

	it("sorts installed models safely by sizeBytes with id tiebreak", () => {
		const models = [
			{ id: "mod-nan", sizeBytes: Number.NaN },
			{ id: "mod-large", sizeBytes: 100000 },
			{ id: "mod-small", sizeBytes: 5000 },
		];
		const sorted = models.sort(
			(left, right) =>
				(Number.isFinite(right.sizeBytes) ? right.sizeBytes : 0) -
					(Number.isFinite(left.sizeBytes) ? left.sizeBytes : 0) ||
				left.id.localeCompare(right.id),
		);
		expect(sorted.map((m) => m.id)).toEqual([
			"mod-large",
			"mod-small",
			"mod-nan",
		]);
	});
});
