/** Unit tests for `installRouterHandler` wiring the routing-policy layer onto the runtime. Deterministic, fake runtime. */
import { type AgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	filterUnavailableLocalInference,
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
		expect(result.map((candidate) => candidate.provider)).toContain(
			"eliza-local-inference",
		);
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
});
