import { afterEach, describe, expect, it, vi } from "vitest";
import type { Character } from "../types/agent";
import type { Memory } from "../types/memory";
import type { ResolvedSection } from "../types/prompt-batcher";
import type { IAgentRuntime } from "../types/runtime";
import { PromptBatcher, PromptDispatcher } from "../utils/prompt-batcher";

describe("PromptBatcher", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createRuntime(overrides?: Partial<IAgentRuntime>) {
		let resolveInit!: () => void;
		const initPromise = new Promise<void>((resolve) => {
			resolveInit = resolve;
		});

		const dynamicPromptExecFromState = vi.fn();
		const logger = {
			debug: vi.fn(),
			warn: vi.fn(),
		};

		const runtime = {
			agentId: "agent-1",
			initPromise,
			character: {
				name: "Test Agent",
				bio: ["A helpful test agent."],
				style: ["clear"],
				topics: ["testing"],
				knowledge: [],
			} as unknown as Character,
			providers: [],
			logger,
			composeState: vi.fn(),
			dynamicPromptExecFromState,
			getCache: vi.fn().mockResolvedValue(undefined),
			setCache: vi.fn().mockResolvedValue(true),
			deleteCache: vi.fn().mockResolvedValue(true),
			getSetting: vi.fn().mockReturnValue(null),
			...overrides,
		} as unknown as IAgentRuntime;

		return {
			runtime,
			resolveInit,
			initPromise,
			dynamicPromptExecFromState,
			logger,
		};
	}

	function createBatcher(runtime: IAgentRuntime, modelSeparation = 0.7) {
		return new PromptBatcher(
			runtime,
			new PromptDispatcher({
				packingDensity: 0.5,
				maxTokensPerCall: 4096,
				maxParallelCalls: 1,
				modelSeparation,
				maxSectionsPerCall: 30,
			}),
			{
				batchSize: 10,
				maxDrainIntervalMs: 300000,
				maxSectionsPerCall: 30,
				packingDensity: 0.5,
				maxTokensPerCall: 4096,
				maxParallelCalls: 1,
				modelSeparation,
			},
		);
	}

	it("resolves a once section after init with structured fields", async () => {
		const { runtime, resolveInit, initPromise, dynamicPromptExecFromState } =
			createRuntime();

		dynamicPromptExecFromState.mockResolvedValue({
			init_intro__instructions: "Introduce yourself briefly.",
		});

		const batcher = createBatcher(runtime);

		resolveInit();
		await initPromise;
		await Promise.resolve();

		const result = await batcher.askOnce("init-intro", {
			preamble: "Generate concise intro instructions.",
			schema: [
				{
					field: "instructions",
					description: "Short intro instructions",
					required: true,
				},
			],
			fallback: { instructions: "Fallback instructions." },
		});

		expect(result.instructions).toBe("Introduce yourself briefly.");
		expect(dynamicPromptExecFromState).toHaveBeenCalledTimes(1);
	});

	it("does not emit duplicate drain logs for a single drain", async () => {
		const {
			runtime,
			resolveInit,
			initPromise,
			dynamicPromptExecFromState,
			logger,
		} = createRuntime();
		const batcher = createBatcher(runtime);

		dynamicPromptExecFromState.mockResolvedValue({
			room_test__summary: "short summary",
		});

		batcher.onDrain("room-test", {
			room: "room-1",
			providers: [],
			preamble: "Summarize the latest activity.",
			schema: [
				{
					field: "summary",
					description: "Room summary",
					required: true,
				},
			],
			onResult: vi.fn(),
		});

		resolveInit();
		await initPromise;
		await Promise.resolve();
		logger.debug.mockClear();

		batcher.tick({
			id: "msg-1",
			roomId: "room-1",
			worldId: "world-1",
			entityId: "user-1",
			agentId: "agent-1",
			content: { text: "hello" },
		} as Memory);

		await batcher.drain();
		await Promise.resolve();
		await Promise.resolve();

		expect(dynamicPromptExecFromState).toHaveBeenCalledTimes(1);
		expect(logger.debug).toHaveBeenCalledTimes(1);
	});

	it("does not re-drain once sections on every tick after shouldRun skips", async () => {
		const { runtime, resolveInit, initPromise, dynamicPromptExecFromState } =
			createRuntime();
		const batcher = createBatcher(runtime);

		resolveInit();
		await initPromise;
		await Promise.resolve();

		const resultPromise = batcher.askOnce("guarded-once", {
			preamble: "This should stay gated.",
			schema: [
				{
					field: "answer",
					description: "Answer",
					required: true,
				},
			],
			shouldRun: () => false,
			fallback: { answer: "fallback" },
		});

		await Promise.resolve();
		await Promise.resolve();

		batcher.tick({
			id: "msg-2",
			roomId: "room-1",
			worldId: "world-1",
			entityId: "user-2",
			agentId: "agent-1",
			content: { text: "hi again" },
		} as Memory);

		await Promise.resolve();
		await Promise.resolve();

		expect(dynamicPromptExecFromState).not.toHaveBeenCalled();

		batcher.dispose();
		await expect(resultPromise).rejects.toThrow(
			"PromptBatcher has been disposed",
		);
	});

	it("rejects the onDrain promise when onResult throws", async () => {
		const { runtime, resolveInit, initPromise, dynamicPromptExecFromState } =
			createRuntime();
		const batcher = createBatcher(runtime);

		dynamicPromptExecFromState.mockResolvedValue({
			room_test__summary: "short summary",
		});

		const onDrainPromise = batcher.onDrain("room-test", {
			room: "room-1",
			providers: [],
			preamble: "Summarize.",
			schema: [{ field: "summary", description: "Summary", required: true }],
			onResult: async () => {
				throw new Error("onResult failed");
			},
		});

		resolveInit();
		await initPromise;
		await Promise.resolve();

		batcher.tick({
			id: "msg-1",
			roomId: "room-1",
			worldId: "world-1",
			entityId: "user-1",
			agentId: "agent-1",
			content: { text: "hello" },
		} as Memory);

		await batcher.drain();
		await Promise.resolve();

		await expect(onDrainPromise).rejects.toThrow("onResult failed");
	});
});

describe("PromptDispatcher", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function resolvedSection(
		id: string,
		model: "small" | "large",
		priority: "background" | "normal" | "immediate" = "normal",
	): ResolvedSection {
		return {
			section: {
				id,
				frequency: "once",
				schema: [
					{
						field: "value",
						description: "Value",
						required: true,
					},
				],
			},
			resolvedContext: `${id} context`,
			contextCharCount: 10,
			schemaFieldCount: 1,
			estimatedTokens: 50,
			priority,
			preferredModel: model,
			isolated: false,
			affinityKey: "shared",
		};
	}

	it("can promote small sections into a large-model call when model separation is low", async () => {
		const dynamicPromptExecFromState = vi.fn().mockResolvedValue({
			alpha__value: "one",
			beta__value: "two",
		});
		const runtime = {
			dynamicPromptExecFromState,
		} as unknown as IAgentRuntime;

		const dispatcher = new PromptDispatcher({
			packingDensity: 1,
			maxTokensPerCall: 4096,
			maxParallelCalls: 1,
			modelSeparation: 0,
			maxSectionsPerCall: 30,
		});

		await dispatcher.dispatch(
			[resolvedSection("alpha", "large"), resolvedSection("beta", "small")],
			runtime,
		);

		expect(dynamicPromptExecFromState).toHaveBeenCalledTimes(1);
		expect(
			dynamicPromptExecFromState.mock.calls[0]?.[0]?.options?.modelSize,
		).toBe("large");
	});
});
