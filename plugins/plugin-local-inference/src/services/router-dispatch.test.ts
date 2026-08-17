/** Proves the router dispatches via runtime introspection rather than a prototype patch. Deterministic, fake runtime. */
import {
	AgentRuntime,
	type Character,
	type IAgentRuntime,
	InMemoryDatabaseAdapter,
	ModelType,
	runWithStreamingContext,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Force a deterministic manual policy pinned to our fake cloud provider so the
// router picks it without consulting device tier / live signals / assignments.
let prefsState = {
	policy: { TEXT_LARGE: "manual" } as Record<string, string>,
	preferredProvider: { TEXT_LARGE: "test-cloud" } as Record<string, string>,
};

vi.mock("./routing-preferences", () => ({
	DEFAULT_ROUTING_POLICY: "prefer-local",
	readRoutingPreferences: vi.fn(async () => prefsState),
}));

import { installRouterHandler, ROUTER_PROVIDER } from "./router-handler";

type Handler = (
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Capture the router handler `installRouterHandler` registers for TEXT_LARGE,
 * then build a runtime whose live `models` map carries a provider handler for
 * the router to introspect and dispatch to — the path that used to depend on
 * the `registerModel` prototype monkey-patch.
 */
function setup(
	providerHandler: Handler,
	options: {
		localHandler?: Handler;
		modelProvider?: string;
		registrationProvider?: string;
	} = {},
) {
	const routerHandlers = new Map<string, Handler>();
	const installTarget = {
		registerModel: vi.fn(
			(modelType: string, handler: Handler, provider: string) => {
				if (provider === ROUTER_PROVIDER)
					routerHandlers.set(modelType, handler);
			},
		),
	} as unknown as AgentRuntime;
	installRouterHandler(installTarget, {
		skipSlots: [
			"TEXT_SMALL",
			"TEXT_EMBEDDING",
			"TEXT_TO_SPEECH",
			"TRANSCRIPTION",
		],
	});

	const runtime = {
		models: new Map<string, unknown[]>([
			[
				ModelType.TEXT_LARGE,
				[
					{
						provider: options.registrationProvider ?? "test-cloud",
						priority: 0,
						handler: providerHandler,
					},
					...(options.localHandler
						? [
								{
									provider: "eliza-local-inference",
									priority: 0,
									handler: options.localHandler,
								},
							]
						: []),
				],
			],
		]),
		getSetting: vi.fn((key: string) =>
			key === "MODEL_PROVIDER" ? options.modelProvider : undefined,
		),
	} as unknown as IAgentRuntime;

	const router = routerHandlers.get(ModelType.TEXT_LARGE);
	if (!router) throw new Error("router handler for TEXT_LARGE not installed");
	return { router, runtime };
}

beforeEach(() => {
	vi.clearAllMocks();
	prefsState = {
		policy: { TEXT_LARGE: "manual" },
		preferredProvider: { TEXT_LARGE: "test-cloud" },
	};
});

describe("router dispatches via runtime introspection, not a prototype patch", () => {
	it("routes V5 response handling through the provider's semantic handler", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const registrations = new Map<string, Handler>();
		const installTarget = {
			registerModel: vi.fn(
				(modelType: string, handler: Handler, provider: string) => {
					if (provider === ROUTER_PROVIDER)
						registrations.set(modelType, handler);
				},
			),
		} as unknown as AgentRuntime;
		installRouterHandler(installTarget, {
			skipSlots: [
				"TEXT_LARGE",
				"TEXT_EMBEDDING",
				"TEXT_TO_SPEECH",
				"TRANSCRIPTION",
			],
		});
		const textSmallHandler = vi.fn(async () => "small-result");
		const responseHandler = vi.fn(async (_runtime, params) => params);
		const localHandler = vi.fn(async () => "local-result");
		const runtime = {
			models: new Map<string, unknown[]>([
				[
					ModelType.TEXT_SMALL,
					[{ provider: "test-cloud", priority: 0, handler: textSmallHandler }],
				],
				[
					ModelType.RESPONSE_HANDLER,
					[
						{ provider: "test-cloud", priority: 0, handler: responseHandler },
						{
							provider: "eliza-local-inference",
							priority: 0,
							handler: localHandler,
						},
					],
				],
			]),
			getSetting: vi.fn((key: string) =>
				key === "MODEL_PROVIDER" ? "test-cloud" : undefined,
			),
		} as unknown as IAgentRuntime;
		const handler = registrations.get(ModelType.RESPONSE_HANDLER);
		if (!handler) throw new Error("semantic router was not registered");
		const params = {
			prompt: "hi",
			responseFormat: { type: "json_schema" },
			tools: [{ name: "answer" }],
		};

		await expect(handler(runtime, params)).resolves.toEqual(params);
		expect(responseHandler).toHaveBeenCalledWith(runtime, params);
		expect(textSmallHandler).not.toHaveBeenCalled();
		expect(localHandler).not.toHaveBeenCalled();
	});

	it("routes action planning through the provider's action-planner handler", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const registrations = new Map<string, Handler>();
		const installTarget = {
			registerModel: vi.fn(
				(modelType: string, handler: Handler, provider: string) => {
					if (provider === ROUTER_PROVIDER)
						registrations.set(modelType, handler);
				},
			),
		} as unknown as AgentRuntime;
		installRouterHandler(installTarget, {
			skipSlots: [
				"TEXT_LARGE",
				"TEXT_EMBEDDING",
				"TEXT_TO_SPEECH",
				"TRANSCRIPTION",
			],
		});
		const textSmallHandler = vi.fn(async () => "small-result");
		const actionPlannerHandler = vi.fn(async (_runtime, params) => params);
		const runtime = {
			models: new Map<string, unknown[]>([
				[
					ModelType.TEXT_SMALL,
					[{ provider: "test-cloud", priority: 0, handler: textSmallHandler }],
				],
				[
					ModelType.ACTION_PLANNER,
					[
						{
							provider: "test-cloud",
							priority: 0,
							handler: actionPlannerHandler,
						},
					],
				],
			]),
			getSetting: vi.fn((key: string) =>
				key === "MODEL_PROVIDER" ? "test-cloud" : undefined,
			),
		} as unknown as IAgentRuntime;
		const handler = registrations.get(ModelType.ACTION_PLANNER);
		if (!handler) throw new Error("action-planner router was not registered");
		const params = { prompt: "plan", tools: [{ name: "ship" }] };

		await expect(handler(runtime, params)).resolves.toEqual(params);
		expect(actionPlannerHandler).toHaveBeenCalledWith(runtime, params);
		expect(textSmallHandler).not.toHaveBeenCalled();
	});

	it("routes text completion through the canonical provider's text handler", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const registrations = new Map<string, Handler>();
		const installTarget = {
			registerModel: vi.fn(
				(modelType: string, handler: Handler, provider: string) => {
					if (provider === ROUTER_PROVIDER)
						registrations.set(modelType, handler);
				},
			),
		} as unknown as AgentRuntime;
		installRouterHandler(installTarget, {
			skipSlots: [
				"TEXT_LARGE",
				"TEXT_EMBEDDING",
				"TEXT_TO_SPEECH",
				"TRANSCRIPTION",
			],
		});
		const cloudTextHandler = vi.fn(async (_runtime, params) => params);
		const localCompletionHandler = vi.fn(async () => "local-result");
		const runtime = {
			models: new Map<string, unknown[]>([
				[
					ModelType.TEXT_SMALL,
					[{ provider: "openai", priority: 0, handler: cloudTextHandler }],
				],
				[
					ModelType.TEXT_COMPLETION,
					[
						{
							provider: "eliza-local-inference",
							priority: 0,
							handler: localCompletionHandler,
						},
					],
				],
			]),
			getSetting: vi.fn((key: string) =>
				key === "MODEL_PROVIDER" ? "cerebras" : undefined,
			),
		} as unknown as IAgentRuntime;
		const handler = registrations.get(ModelType.TEXT_COMPLETION);
		if (!handler) throw new Error("text-completion router was not registered");
		const params = { prompt: "complete this" };

		await expect(handler(runtime, params)).resolves.toEqual(params);
		expect(cloudTextHandler).toHaveBeenCalledWith(runtime, params);
		expect(localCompletionHandler).not.toHaveBeenCalled();
	});

	it("does not invoke a local semantic handler when canonical provider is absent", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const registrations = new Map<string, Handler>();
		const installTarget = {
			registerModel: vi.fn(
				(modelType: string, handler: Handler, provider: string) => {
					if (provider === ROUTER_PROVIDER)
						registrations.set(modelType, handler);
				},
			),
		} as unknown as AgentRuntime;
		installRouterHandler(installTarget, {
			skipSlots: [
				"TEXT_LARGE",
				"TEXT_EMBEDDING",
				"TEXT_TO_SPEECH",
				"TRANSCRIPTION",
			],
		});
		const localHandler = vi.fn(async () => "local-result");
		const runtime = {
			models: new Map<string, unknown[]>([
				[
					ModelType.RESPONSE_HANDLER,
					[
						{
							provider: "eliza-local-inference",
							priority: 0,
							handler: localHandler,
						},
					],
				],
			]),
			getSetting: vi.fn((key: string) =>
				key === "MODEL_PROVIDER" ? "test-cloud" : undefined,
			),
		} as unknown as IAgentRuntime;
		const handler = registrations.get(ModelType.RESPONSE_HANDLER);
		if (!handler) throw new Error("semantic router was not registered");

		await expect(handler(runtime, { prompt: "hi" })).rejects.toThrow(
			"Configured provider test-cloud is not registered for TEXT_SMALL",
		);
		expect(localHandler).not.toHaveBeenCalled();
	});

	it("invokes the registered provider handler resolved from runtime.models", async () => {
		const providerHandler = vi.fn(async () => "cloud-result");
		const { router, runtime } = setup(providerHandler);

		const result = await router(runtime, { prompt: "hi" });

		expect(result).toBe("cloud-result");
		expect(providerHandler).toHaveBeenCalledTimes(1);
		expect(providerHandler).toHaveBeenCalledWith(runtime, { prompt: "hi" });
	});

	it("surfaces the provider error in manual mode (no silent fallback)", async () => {
		const boom = new Error("cloud down");
		const providerHandler = vi.fn(async () => {
			throw boom;
		});
		const { router, runtime } = setup(providerHandler);

		await expect(router(runtime, { prompt: "hi" })).rejects.toBe(boom);
	});

	it("honors canonical text provider when no per-slot override exists", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const cloudHandler = vi.fn(async () => "cloud-result");
		const localHandler = vi.fn(async () => "local-result");
		const { router, runtime } = setup(cloudHandler, {
			localHandler,
			modelProvider: "test-cloud",
		});

		await expect(router(runtime, { prompt: "hi" })).resolves.toBe(
			"cloud-result",
		);
		expect(cloudHandler).toHaveBeenCalledTimes(1);
		expect(localHandler).not.toHaveBeenCalled();
	});

	it("routes Cerebras through plugin-openai without losing canonical provider truth", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const openAiPluginHandler = vi.fn(async () => "cerebras-result");
		const localHandler = vi.fn(async () => "local-result");
		const { router, runtime } = setup(openAiPluginHandler, {
			localHandler,
			modelProvider: "cerebras",
			registrationProvider: "openai",
		});

		await expect(router(runtime, { prompt: "hi" })).resolves.toBe(
			"cerebras-result",
		);
		expect(openAiPluginHandler).toHaveBeenCalledTimes(1);
		expect(localHandler).not.toHaveBeenCalled();
		expect(runtime.getSetting).toHaveBeenCalledWith("MODEL_PROVIDER");
	});

	it("fails closed when the canonical text provider is not registered", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const cloudHandler = vi.fn(async () => "cloud-result");
		const localHandler = vi.fn(async () => "local-result");
		const { router, runtime } = setup(cloudHandler, {
			localHandler,
			modelProvider: "MISSING-CLOUD",
		});

		await expect(router(runtime, { prompt: "hi" })).rejects.toThrow(
			"Configured provider missing-cloud is not registered for TEXT_LARGE",
		);
		expect(cloudHandler).not.toHaveBeenCalled();
		expect(localHandler).not.toHaveBeenCalled();
	});

	it("keeps automatic routing when no canonical provider is configured", async () => {
		prefsState = { policy: {}, preferredProvider: {} };
		const cloudHandler = vi.fn(async () => "cloud-result");
		const localHandler = vi.fn(async () => "local-result");
		const { router, runtime } = setup(cloudHandler, { localHandler });

		await expect(router(runtime, { prompt: "hi" })).resolves.toBe(
			"cloud-result",
		);
		// The deterministic harness has no loaded local model, so prefer-local
		// correctly keeps its existing cloud fallback rather than becoming manual.
		expect(cloudHandler).toHaveBeenCalledTimes(1);
		expect(localHandler).not.toHaveBeenCalled();
	});

	it("keeps an explicit per-slot provider authoritative over canonical text routing", async () => {
		const cloudHandler = vi.fn(async () => "cloud-result");
		const localHandler = vi.fn(async () => "local-result");
		const { router, runtime } = setup(cloudHandler, {
			localHandler,
			modelProvider: "test-cloud",
		});
		prefsState = {
			policy: { TEXT_LARGE: "manual" },
			preferredProvider: { TEXT_LARGE: "eliza-local-inference" },
		};

		await expect(router(runtime, { prompt: "hi" })).resolves.toBe(
			"local-result",
		);
		expect(localHandler).toHaveBeenCalledTimes(1);
		expect(cloudHandler).not.toHaveBeenCalled();
	});

	it("passes scalar model parameters through without applying stream ownership", async () => {
		const providerHandler = vi.fn(async (_runtime, params) => params);
		const { router, runtime } = setup(providerHandler);

		await expect(router(runtime, "embedding input" as never)).resolves.toBe(
			"embedding input",
		);
		expect(providerHandler).toHaveBeenCalledWith(runtime, "embedding input");
	});

	it("delivers hosted TextStreamResult chunks exactly once through AgentRuntime", async () => {
		const chunks = ["cloud ", "result"];
		const providerHandler = vi.fn(
			async (_runtime: IAgentRuntime, params: Record<string, unknown>) => ({
				textStream: (async function* () {
					for (const chunk of chunks) {
						await (
							params.onStreamChunk as
								| ((value: string) => Promise<void> | void)
								| undefined
						)?.(chunk);
						yield chunk;
					}
				})(),
				text: Promise.resolve(chunks.join("")),
				usage: Promise.resolve(undefined),
				finishReason: Promise.resolve("stop"),
			}),
		);
		const runtime = new AgentRuntime({
			character: { name: "RouterStreamAgent", bio: "test" } as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			providerHandler,
			"test-cloud",
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
		const received: string[] = [];

		const result = await runWithStreamingContext(
			{
				messageId: "router-stream-once",
				onStreamChunk: (chunk) => received.push(chunk),
			},
			() => runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hi" }),
		);

		expect(result).toBe(chunks.join(""));
		expect(received).toEqual(chunks);
		expect(providerHandler).toHaveBeenCalledTimes(1);
		expect(providerHandler.mock.calls[0]?.[1]).not.toHaveProperty(
			"onStreamChunk",
		);
	});
});
