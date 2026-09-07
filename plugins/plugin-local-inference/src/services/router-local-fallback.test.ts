/**
 * Exercises local text admission through the real router and AgentRuntime.
 * Deterministic model handlers and readiness inputs isolate fallback behavior;
 * no model is loaded, downloaded, or called over the network.
 */
import {
	AgentRuntime,
	type Character,
	type GenerateTextParams,
	type IAgentRuntime,
	InMemoryDatabaseAdapter,
	MODEL_PROVIDER_ATTEMPTS,
	type ModelProviderAttempt,
	ModelType,
	runWithStreamingContext,
	type StreamChunkCallback,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readiness = vi.hoisted(() => ({
	loaded: false,
	assignments: {} as Record<string, string>,
	policy: "manual",
	preferred: "test-cloud",
}));
vi.mock("./engine", () => ({
	localInferenceEngine: { hasLoadedModel: () => readiness.loaded },
}));
vi.mock("./hardware", () => ({
	probeHardware: async () => ({
		totalRamGb: 64,
		freeRamGb: 48,
		gpu: null,
		cpuCores: 12,
		platform: "darwin",
		arch: "arm64",
		appleSilicon: true,
		recommendedBucket: "high",
		source: "test",
	}),
}));
vi.mock("./assignments", () => ({
	readEffectiveAssignments: async () => readiness.assignments,
}));
vi.mock("./routing-preferences", () => ({
	DEFAULT_ROUTING_POLICY: "prefer-local",
	readRoutingPreferences: async () => ({
		policy: { TEXT_SMALL: readiness.policy, TEXT_LARGE: readiness.policy },
		preferredProvider: {
			TEXT_SMALL: readiness.preferred,
			TEXT_LARGE: readiness.preferred,
		},
	}),
}));

import { LocalInferenceUnavailableError } from "../provider";
import { installRouterHandler, ROUTER_PROVIDER } from "./router-handler";

function makeRuntime(preferCloud: boolean) {
	return new AgentRuntime({
		character: {
			name: "LocalAdmissionAgent",
			bio: "test",
			settings: preferCloud ? { ELIZA_BRAIN_PROVIDER: "test-cloud" } : {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

function install(runtime: AgentRuntime) {
	installRouterHandler(runtime, {
		skipSlots: ["TEXT_EMBEDDING", "TEXT_TO_SPEECH", "TRANSCRIPTION"],
	});
}

beforeEach(() => {
	readiness.loaded = false;
	readiness.assignments = {};
	readiness.policy = "manual";
	readiness.preferred = "test-cloud";
});

describe("router and outer runtime share local text admission", () => {
	it.each([false, true])(
		"preserves the cloud 429 without dispatching inactive local aliases (brain override: %s)",
		async (preferCloud) => {
			const runtime = makeRuntime(preferCloud);
			const limited = Object.assign(new Error("Cerebras TPM exhausted"), {
				status: 429,
			});
			let attempts: ModelProviderAttempt[] = [];
			const cloud = vi.fn(
				async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
					attempts = params[MODEL_PROVIDER_ATTEMPTS] ?? [];
					throw limited;
				},
			);
			const local = vi.fn(async () => {
				throw new Error("inactive local handler must not run");
			});
			runtime.registerModel(ModelType.TEXT_SMALL, cloud, "test-cloud", 100);
			runtime.registerModel(
				ModelType.TEXT_SMALL,
				local,
				"eliza-local-inference",
				-100,
			);
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				local,
				"eliza-local-inference",
				-100,
			);
			install(runtime);
			const report = vi.spyOn(runtime, "reportError");

			await expect(
				runtime.useModel(ModelType.TEXT_SMALL, {
					prompt: "Complete user input",
				}),
			).rejects.toBe(limited);
			expect(cloud).toHaveBeenCalledTimes(1);
			expect(local).not.toHaveBeenCalled();
			expect(
				attempts.filter((attempt) => attempt.provider === "test-cloud"),
			).toHaveLength(1);
			expect(
				attempts.some(
					(attempt) => attempt.provider === "eliza-local-inference",
				),
			).toBe(false);
			expect(
				attempts.some((attempt) => attempt.provider === ROUTER_PROVIDER),
			).toBe(true);
			expect(report).not.toHaveBeenCalled();
		},
	);

	it.each(["loaded", "assigned"])(
		"allows a healthy %s local fallback after a cloud 429",
		async (state) => {
			readiness.loaded = state === "loaded";
			if (state === "assigned")
				readiness.assignments.TEXT_LARGE = "installed-test-model";
			const runtime = makeRuntime(true);
			const cloud = vi.fn(async () => {
				throw Object.assign(new Error("rate limit"), { status: 429 });
			});
			const local = vi.fn(
				async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
					expect(params.prompt).toBe("Complete user input");
					return "healthy local response";
				},
			);
			runtime.registerModel(ModelType.TEXT_LARGE, cloud, "test-cloud", 100);
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				local,
				"eliza-local-inference",
				-100,
			);
			install(runtime);
			await expect(
				runtime.useModel(ModelType.TEXT_LARGE, {
					prompt: "Complete user input",
				}),
			).resolves.toBe("healthy local response");
			expect(local).toHaveBeenCalledTimes(1);
			expect(cloud).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps a later provider's terminal failure authoritative after local admission is rejected", async () => {
		const runtime = makeRuntime(true);
		const terminal = new Error("invalid request payload");
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => {
				throw Object.assign(new Error("rate limit"), { status: 429 });
			},
			"test-cloud",
			100,
		);
		const local = vi.fn(async () => "must not run");
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			local,
			"eliza-local-inference",
			50,
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			async () => {
				throw terminal;
			},
			"other-cloud",
			0,
		);
		install(runtime);
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "input" }),
		).rejects.toBe(terminal);
		expect(local).not.toHaveBeenCalled();
	});

	it.each(["local-only", "manual"])(
		"preserves explicitly forced local eligibility (%s)",
		async (policy) => {
			readiness.policy = policy;
			readiness.preferred = "eliza-local-inference";
			const runtime = makeRuntime(false);
			const unavailable = new LocalInferenceUnavailableError(
				ModelType.TEXT_LARGE,
				"backend_unavailable",
				"Local model is not active",
			);
			const local = vi.fn(async () => {
				throw unavailable;
			});
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				local,
				"eliza-local-inference",
				0,
			);
			install(runtime);
			await expect(
				runtime.useModel(
					ModelType.TEXT_LARGE,
					{ prompt: "input" },
					"eliza-local-inference",
				),
			).rejects.toBe(unavailable);
			expect(local).toHaveBeenCalledTimes(1);
		},
	);
	it("still reports genuinely missing registrations as unconfigured", async () => {
		const runtime = makeRuntime(false);
		install(runtime);
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "input" }),
		).rejects.toMatchObject({
			name: "NoModelProviderConfiguredError",
			reason: "no-provider",
		});
	});
	it.each(["invalid_input", "invalid_output", "auth"])(
		"automatic routing stops at terminal %s errors before a third provider",
		async (reason) => {
			readiness.policy = "prefer-local";
			readiness.loaded = true;
			const runtime = makeRuntime(true);
			const terminal =
				reason === "auth"
					? Object.assign(new Error("unauthorized"), { status: 401 })
					: new LocalInferenceUnavailableError(
							ModelType.TEXT_LARGE,
							reason as "invalid_input" | "invalid_output",
							"Invalid local request/output",
						);
			const cloud = vi.fn(async () => {
				throw Object.assign(new Error("rate limit"), { status: 429 });
			});
			const local = vi.fn(async () => {
				throw terminal;
			});
			const healthy = vi.fn(async () => "must not hide terminal failure");
			runtime.registerModel(ModelType.TEXT_LARGE, cloud, "test-cloud", 100);
			runtime.registerModel(
				ModelType.TEXT_LARGE,
				local,
				"eliza-local-inference",
				50,
			);
			runtime.registerModel(ModelType.TEXT_LARGE, healthy, "third-provider", 0);
			install(runtime);
			await expect(
				runtime.useModel(ModelType.TEXT_LARGE, { prompt: "input" }),
			).rejects.toBe(terminal);
			expect(cloud).toHaveBeenCalledTimes(1);
			expect(local).toHaveBeenCalledTimes(1);
			expect(healthy).not.toHaveBeenCalled();
		},
	);

	it("retains the internal router provider error if its last local fallback becomes unavailable", async () => {
		readiness.policy = "round-robin";
		readiness.loaded = true;
		const runtime = makeRuntime(false);
		const limited = Object.assign(new Error("rate limit"), { status: 429 });
		const cloud = vi.fn(async () => {
			throw limited;
		});
		const local = vi.fn(async () => {
			throw new LocalInferenceUnavailableError(
				ModelType.TEXT_LARGE,
				"backend_unavailable",
				"Local model unloaded",
			);
		});
		runtime.registerModel(ModelType.TEXT_LARGE, cloud, "new-cloud", 100);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			local,
			"eliza-local-inference",
			0,
		);
		installRouterHandler(runtime, {
			skipSlots: [
				"TEXT_SMALL",
				"TEXT_EMBEDDING",
				"TEXT_TO_SPEECH",
				"TRANSCRIPTION",
			],
		});
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "input" }),
		).rejects.toBe(limited);
		expect(cloud).toHaveBeenCalledTimes(1);
		expect(local).toHaveBeenCalledTimes(1);
	});
	it("does not replace callback output or its failure with another provider", async () => {
		readiness.policy = "prefer-local";
		readiness.loaded = true;
		const runtime = makeRuntime(true);
		const unavailable = new LocalInferenceUnavailableError(
			ModelType.TEXT_LARGE,
			"backend_unavailable",
			"Local model unloaded after output",
		);
		const cloud = vi.fn(async () => {
			throw Object.assign(new Error("rate limit"), { status: 429 });
		});
		const local = vi.fn(
			async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
				await (params.onStreamChunk as StreamChunkCallback)(
					"partial local output",
				);
				throw unavailable;
			},
		);
		const healthy = vi.fn(async () => "must not replace output");
		runtime.registerModel(ModelType.TEXT_LARGE, cloud, "test-cloud", 100);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			local,
			"eliza-local-inference",
			50,
			{ streamable: true },
		);
		runtime.registerModel(ModelType.TEXT_LARGE, healthy, "third-provider", 0);
		install(runtime);
		const chunks: string[] = [];
		await expect(
			runWithStreamingContext(
				{
					messageId: "router-partial-output",
					onStreamChunk: (chunk) => chunks.push(chunk),
				},
				() => runtime.useModel(ModelType.TEXT_LARGE, { prompt: "input" }),
			),
		).rejects.toBe(unavailable);
		expect(chunks).toEqual(["partial local output"]);
		expect(cloud).toHaveBeenCalledTimes(1);
		expect(local).toHaveBeenCalledTimes(1);
		expect(healthy).not.toHaveBeenCalled();
	});
	it.each([
		ModelType.RESPONSE_HANDLER,
		ModelType.ACTION_PLANNER,
		ModelType.TEXT_COMPLETION,
	])(
		"rejects inactive direct %s aliases before dispatch",
		async (modelType) => {
			const runtime = makeRuntime(true);
			const limited = Object.assign(new Error("rate limit"), { status: 429 });
			const cloud = vi.fn(async () => {
				throw limited;
			});
			const local = vi.fn(async () => "inactive local alias must not run");
			runtime.registerModel(modelType, cloud, "test-cloud", 100);
			for (const type of [
				modelType,
				ModelType.TEXT_SMALL,
				ModelType.TEXT_LARGE,
			])
				runtime.registerModel(type, local, "eliza-local-inference", -100, {
					local: true,
					streamable: true,
				});
			install(runtime);
			await expect(
				runtime.useModel(modelType, { prompt: "input" }),
			).rejects.toBe(limited);
			expect(cloud).toHaveBeenCalledTimes(1);
			expect(local).not.toHaveBeenCalled();
		},
	);

	it.each([
		ModelType.RESPONSE_HANDLER,
		ModelType.ACTION_PLANNER,
		ModelType.TEXT_COMPLETION,
	])(
		"does not admit %s using an unrelated TEXT_LARGE assignment",
		async (modelType) => {
			readiness.assignments.TEXT_LARGE = "installed-large-model";
			const runtime = makeRuntime(false);
			const local = vi.fn(async () => "wrong slot must not run");
			runtime.registerModel(modelType, local, "eliza-local-inference", -100, {
				local: true,
				streamable: true,
			});
			install(runtime);
			await expect(
				runtime.useModel(
					modelType,
					{ prompt: "input" },
					"eliza-local-inference",
				),
			).rejects.toMatchObject({ code: "LOCAL_INFERENCE_UNAVAILABLE" });
			expect(local).not.toHaveBeenCalled();
		},
	);

	it.each([
		ModelType.RESPONSE_HANDLER,
		ModelType.ACTION_PLANNER,
		ModelType.TEXT_COMPLETION,
	])(
		"admits a healthy %s using its TEXT_SMALL assignment",
		async (modelType) => {
			readiness.assignments.TEXT_SMALL = "installed-small-model";
			const runtime = makeRuntime(false);
			const local = vi.fn(async () => "healthy small-slot response");
			runtime.registerModel(modelType, local, "eliza-local-inference", -100, {
				local: true,
				streamable: true,
			});
			install(runtime);
			await expect(
				runtime.useModel(
					modelType,
					{ prompt: "input" },
					"eliza-local-inference",
				),
			).resolves.toBe("healthy small-slot response");
			expect(local).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["manual", "local-only"])(
		"preserves forced small-slot alias eligibility under %s",
		async (policy) => {
			readiness.policy = policy;
			readiness.preferred = "eliza-local-inference";
			const runtime = makeRuntime(false);
			const unavailable = new LocalInferenceUnavailableError(
				ModelType.TEXT_SMALL,
				"backend_unavailable",
				"Small local slot is not active",
			);
			const local = vi.fn(async () => {
				throw unavailable;
			});
			runtime.registerModel(
				ModelType.RESPONSE_HANDLER,
				local,
				"eliza-local-inference",
				-100,
				{ local: true, streamable: true },
			);
			install(runtime);
			await expect(
				runtime.useModel(
					ModelType.RESPONSE_HANDLER,
					{ prompt: "input" },
					"eliza-local-inference",
				),
			).rejects.toBe(unavailable);
			expect(local).toHaveBeenCalledTimes(1);
		},
	);
});
