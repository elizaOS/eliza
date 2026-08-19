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
const prefsState = {
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
function setup(providerHandler: Handler) {
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
				[{ provider: "test-cloud", priority: 0, handler: providerHandler }],
			],
		]),
	} as unknown as IAgentRuntime;

	const router = routerHandlers.get(ModelType.TEXT_LARGE);
	if (!router) throw new Error("router handler for TEXT_LARGE not installed");
	return { router, runtime };
}

beforeEach(() => {
	vi.clearAllMocks();
	prefsState.policy = { TEXT_LARGE: "manual" };
	prefsState.preferredProvider = { TEXT_LARGE: "test-cloud" };
});

describe("router dispatches via runtime introspection, not a prototype patch", () => {
	it("invokes the registered provider handler resolved from runtime.models", async () => {
		const providerHandler = vi.fn(async () => "cloud-result");
		const { router, runtime } = setup(providerHandler);

		const result = await router(runtime, { prompt: "hi" });

		expect(result).toBe("cloud-result");
		expect(providerHandler).toHaveBeenCalledTimes(1);
		expect(providerHandler).toHaveBeenCalledWith(runtime, { prompt: "hi" });
	});

	it.each([
		["response handling", ModelType.RESPONSE_HANDLER],
		["background action planning", ModelType.ACTION_PLANNER],
	])(
		"routes %s through canonical Cerebras instead of loading local text",
		async (_label, semanticModelType) => {
			prefsState.policy = {};
			prefsState.preferredProvider = {};
			const routerHandlers = new Map<string, Handler>();
			const installTarget = {
				registerModel: vi.fn(
					(modelType: string, handler: Handler, provider: string) => {
						if (provider === ROUTER_PROVIDER)
							routerHandlers.set(modelType, handler);
					},
				),
			} as unknown as AgentRuntime;
			installRouterHandler(installTarget);
			const cerebrasHandler = vi.fn(async () => "planned-by-cerebras");
			const localHandler = vi.fn(async () => "planned-locally");
			const runtime = {
				getSetting: vi.fn((key: string) =>
					key === "MODEL_PROVIDER" ? "cerebras" : undefined,
				),
				models: new Map<string, unknown[]>([
					[
						semanticModelType,
						[
							{ provider: "openai", priority: 50, handler: cerebrasHandler },
							{
								provider: "eliza-local-inference",
								priority: 0,
								handler: localHandler,
							},
						],
					],
				]),
			} as unknown as IAgentRuntime;
			const router = routerHandlers.get(semanticModelType);
			if (!router)
				throw new Error(`${semanticModelType} router was not registered`);

			await expect(router(runtime, { prompt: "plan" })).resolves.toBe(
				"planned-by-cerebras",
			);
			expect(cerebrasHandler).toHaveBeenCalledOnce();
			expect(localHandler).not.toHaveBeenCalled();
		},
	);

	it("fails closed instead of invoking local semantics when canonical provider is absent", async () => {
		prefsState.policy = {};
		prefsState.preferredProvider = {};
		const routerHandlers = new Map<string, Handler>();
		const installTarget = {
			registerModel: vi.fn(
				(modelType: string, handler: Handler, provider: string) => {
					if (provider === ROUTER_PROVIDER)
						routerHandlers.set(modelType, handler);
				},
			),
		} as unknown as AgentRuntime;
		installRouterHandler(installTarget);
		const localHandler = vi.fn(async () => "planned-locally");
		const runtime = {
			getSetting: vi.fn((key: string) =>
				key === "MODEL_PROVIDER" ? "cerebras" : undefined,
			),
			models: new Map<string, unknown[]>([
				[
					ModelType.ACTION_PLANNER,
					[
						{
							provider: "eliza-local-inference",
							priority: 0,
							handler: localHandler,
						},
					],
				],
			]),
		} as unknown as IAgentRuntime;
		const router = routerHandlers.get(ModelType.ACTION_PLANNER);
		if (!router) throw new Error("ACTION_PLANNER router was not registered");

		await expect(router(runtime, { prompt: "plan" })).rejects.toThrow(
			"Configured provider cerebras is not registered",
		);
		expect(localHandler).not.toHaveBeenCalled();
	});

	it("surfaces the provider error in manual mode (no silent fallback)", async () => {
		const boom = new Error("cloud down");
		const providerHandler = vi.fn(async () => {
			throw boom;
		});
		const { router, runtime } = setup(providerHandler);

		await expect(router(runtime, { prompt: "hi" })).rejects.toBe(boom);
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
