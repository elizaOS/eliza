/**
 * Unit coverage for trajectory action and provider interception exercises the
 * real wrappers with deterministic service observers and runtime inputs.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	Plugin,
	Provider,
	State,
} from "../../types";
import {
	clearTrajectoryContext,
	getTrajectoryContext,
	logLLMCallFromAction,
	logProviderFromAction,
	setTrajectoryContext,
	snapshotStateForTrajectory,
	wrapActionWithLogging,
	wrapPluginActions,
	wrapPluginProviders,
	wrapProviderWithLogging,
} from "./action-interceptor.ts";
import type { TrajectoriesService } from "./TrajectoriesService.ts";

function createRuntime(): IAgentRuntime {
	return { agentId: crypto.randomUUID() } as IAgentRuntime;
}

function createTrajectoryLogger(stepId: string | null = "step-1") {
	return {
		getCurrentStepId: vi.fn(() => stepId),
		completeStep: vi.fn(),
		logLLMCall: vi.fn(),
		logProviderAccess: vi.fn(),
	} as unknown as TrajectoriesService & {
		getCurrentStepId: ReturnType<typeof vi.fn>;
		completeStep: ReturnType<typeof vi.fn>;
		logLLMCall: ReturnType<typeof vi.fn>;
		logProviderAccess: ReturnType<typeof vi.fn>;
	};
}

function createMessage(text = "hello"): Memory {
	return { content: { text } } as Memory;
}

function createState(): State {
	return {
		values: { topic: "tests" },
		data: {},
		text: "state text",
	} as State;
}

function createAction(handler: Action["handler"]): Action {
	return {
		name: "RECORD_ACTION",
		description: "records an action",
		similes: [],
		examples: [],
		handler,
	} as Action;
}

describe("trajectory context and state snapshots", () => {
	it("sets, replaces, and clears context per runtime", () => {
		const runtime = createRuntime();
		const firstLogger = createTrajectoryLogger();
		const secondLogger = createTrajectoryLogger();

		expect(getTrajectoryContext(runtime)).toBeNull();
		setTrajectoryContext(runtime, "trajectory-1", firstLogger);
		expect(getTrajectoryContext(runtime)).toEqual({
			trajectoryId: "trajectory-1",
			logger: firstLogger,
		});
		setTrajectoryContext(runtime, "trajectory-2", secondLogger);
		expect(getTrajectoryContext(runtime)).toEqual({
			trajectoryId: "trajectory-2",
			logger: secondLogger,
		});
		clearTrajectoryContext(runtime);
		expect(getTrajectoryContext(runtime)).toBeNull();
	});

	it("returns null for absent state and sanitizes cyclic state", () => {
		const cyclic: Record<string, unknown> = { value: 42 };
		cyclic.self = cyclic;

		expect(snapshotStateForTrajectory(undefined)).toBeNull();
		expect(snapshotStateForTrajectory(null)).toBeNull();
		expect(snapshotStateForTrajectory(cyclic)).toEqual({
			value: 42,
			self: "[Circular]",
		});
	});

	it("degrades a poisoned state getter without failing the caller", () => {
		const state = {
			get value() {
				throw new Error("poisoned state");
			},
		};

		expect(snapshotStateForTrajectory(state)).toBeNull();
	});

	it("degrades a non-Error thrown by a poisoned getter", () => {
		const state = {
			get value() {
				throw "poisoned string";
			},
		};

		expect(snapshotStateForTrajectory(state)).toBeNull();
	});
});

describe("wrapActionWithLogging", () => {
	it("passes all arguments and normalizes a null result without context", async () => {
		const runtime = createRuntime();
		const message = createMessage();
		const state = createState();
		const options = { parameters: { enabled: true } };
		const callback = vi.fn() as HandlerCallback;
		const handler = vi.fn(async () => null);
		const wrapped = wrapActionWithLogging(
			createAction(handler as Action["handler"]),
			createTrajectoryLogger(),
		);

		await expect(
			wrapped.handler?.(runtime, message, state, options, callback),
		).resolves.toBeUndefined();
		expect(handler).toHaveBeenCalledWith(
			runtime,
			message,
			state,
			options,
			callback,
		);
	});

	it("executes without recording when the trajectory has no active step", async () => {
		const runtime = createRuntime();
		const trajectoryLogger = createTrajectoryLogger(null);
		const result = { success: true, text: "handled" };
		const wrapped = wrapActionWithLogging(
			createAction(async () => result),
			trajectoryLogger,
		);
		setTrajectoryContext(runtime, "trajectory-1", trajectoryLogger);

		await expect(
			wrapped.handler?.(runtime, createMessage(), createState()),
		).resolves.toBe(result);
		expect(trajectoryLogger.completeStep).not.toHaveBeenCalled();
	});

	it("records a successful action with the observed message and state", async () => {
		const runtime = createRuntime();
		const trajectoryLogger = createTrajectoryLogger();
		const state = createState();
		const result = { success: true, text: "handled" };
		const wrapped = wrapActionWithLogging(
			createAction(async () => result),
			trajectoryLogger,
		);
		setTrajectoryContext(runtime, "trajectory-1", trajectoryLogger);

		await expect(
			wrapped.handler?.(runtime, createMessage("run it"), state),
		).resolves.toBe(result);
		expect(trajectoryLogger.completeStep).toHaveBeenCalledWith(
			"trajectory-1",
			"step-1",
			{
				actionType: "RECORD_ACTION",
				actionName: "RECORD_ACTION",
				parameters: {
					message: "run it",
					state: snapshotStateForTrajectory(state),
				},
				success: true,
				result: { executed: true },
				reasoning: "Action RECORD_ACTION executed via records an action",
			},
			{ reward: 0.1 },
		);
	});

	it("uses empty input and handler fallbacks when optional action data is absent", async () => {
		const runtime = createRuntime();
		const trajectoryLogger = createTrajectoryLogger();
		const action = createAction(async () => undefined);
		action.description = "";
		const wrapped = wrapActionWithLogging(action, trajectoryLogger);
		setTrajectoryContext(runtime, "trajectory-1", trajectoryLogger);

		await expect(
			wrapped.handler?.(runtime, { content: {} } as Memory),
		).resolves.toBeUndefined();
		expect(trajectoryLogger.completeStep).toHaveBeenCalledWith(
			"trajectory-1",
			"step-1",
			expect.objectContaining({
				parameters: { message: "", state: null },
				reasoning: "Action RECORD_ACTION executed via handler",
			}),
			{ reward: 0.1 },
		);
	});

	it.each([
		new Error("error failure"),
		"string failure",
		{ message: "object failure" },
		{},
	])("records and rethrows action failure %#", async (failure) => {
		const runtime = createRuntime();
		const trajectoryLogger = createTrajectoryLogger();
		const wrapped = wrapActionWithLogging(
			createAction(async () => {
				throw failure;
			}),
			trajectoryLogger,
		);
		setTrajectoryContext(runtime, "trajectory-error", trajectoryLogger);

		await expect(
			wrapped.handler?.(runtime, createMessage("fail"), createState()),
		).rejects.toBe(failure);
		expect(trajectoryLogger.completeStep).toHaveBeenCalledWith(
			"trajectory-error",
			"step-1",
			expect.objectContaining({
				success: false,
				result: {
					error:
						failure instanceof Error
							? failure.message
							: typeof failure === "string"
								? failure
								: failure.message || String(failure),
				},
			}),
			{ reward: -0.1 },
		);
	});
});

describe("plugin action wrapping", () => {
	it("returns plugins without actions unchanged", () => {
		const trajectoryLogger = createTrajectoryLogger();
		const withoutActions = { name: "empty" } as Plugin;
		const withEmptyActions = { name: "empty-list", actions: [] } as Plugin;

		expect(wrapPluginActions(withoutActions, trajectoryLogger)).toBe(
			withoutActions,
		);
		expect(wrapPluginActions(withEmptyActions, trajectoryLogger)).toBe(
			withEmptyActions,
		);
	});

	it("wraps every action while preserving plugin metadata", () => {
		const first = createAction(async () => ({ success: true }));
		const second = { ...first, name: "SECOND_ACTION" };
		const plugin = {
			name: "action-plugin",
			description: "metadata",
			actions: [first, second],
		} as Plugin;

		const wrapped = wrapPluginActions(plugin, createTrajectoryLogger());

		expect(wrapped).not.toBe(plugin);
		expect(wrapped.description).toBe("metadata");
		expect(wrapped.actions).toHaveLength(2);
		expect(wrapped.actions?.[0]).not.toBe(first);
		expect(wrapped.actions?.[1]).not.toBe(second);
	});
});

describe("action-originated trajectory records", () => {
	it("does nothing when no trajectory step is active", () => {
		const trajectoryLogger = createTrajectoryLogger(null);

		logLLMCallFromAction({}, trajectoryLogger, "trajectory-1");
		logProviderFromAction({}, trajectoryLogger, "trajectory-1");

		expect(trajectoryLogger.logLLMCall).not.toHaveBeenCalled();
		expect(trajectoryLogger.logProviderAccess).not.toHaveBeenCalled();
	});

	it("records LLM fields, defaults absent text, and rejects non-finite token counts", () => {
		const trajectoryLogger = createTrajectoryLogger();

		logLLMCallFromAction(
			{
				model: "gpt-test",
				systemPrompt: "system",
				userPrompt: 7,
				response: undefined,
				reasoning: "because",
				temperature: 0.25,
				maxTokens: 512,
				purpose: "evaluation",
				actionType: "CHECK",
				promptTokens: Number.POSITIVE_INFINITY,
				completionTokens: 12,
				latencyMs: 8,
			},
			trajectoryLogger,
			"trajectory-1",
		);

		expect(trajectoryLogger.logLLMCall).toHaveBeenCalledWith("step-1", {
			model: "gpt-test",
			systemPrompt: "system",
			userPrompt: "",
			response: "",
			reasoning: "because",
			temperature: 0.25,
			maxTokens: 512,
			purpose: "evaluation",
			actionType: "CHECK",
			promptTokens: undefined,
			completionTokens: 12,
			latencyMs: 8,
		});
	});

	it("applies LLM defaults when optional metadata is absent", () => {
		const trajectoryLogger = createTrajectoryLogger();

		logLLMCallFromAction(
			{ model: "gpt-test" },
			trajectoryLogger,
			"trajectory-1",
		);

		expect(trajectoryLogger.logLLMCall).toHaveBeenCalledWith(
			"step-1",
			expect.objectContaining({
				reasoning: undefined,
				purpose: "action",
				actionType: undefined,
				promptTokens: undefined,
				completionTokens: undefined,
				latencyMs: undefined,
			}),
		);
	});

	it.each([{ model: "   " }, { model: 42 }])(
		"rejects an invalid required model: $model",
		(context) => {
			expect(() =>
				logLLMCallFromAction(context, createTrajectoryLogger(), "trajectory-1"),
			).toThrow("Trajectory action context requires model");
		},
	);

	it("records provider data and defaults invalid optional fields", () => {
		const trajectoryLogger = createTrajectoryLogger();
		const data = { answer: 42 };

		logProviderFromAction(
			{ providerName: "facts", data, purpose: "", query: [] },
			trajectoryLogger,
			"trajectory-1",
		);

		expect(trajectoryLogger.logProviderAccess).toHaveBeenCalledWith("step-1", {
			providerName: "facts",
			data,
			purpose: "action",
			query: undefined,
		});
	});

	it("preserves a provider query object and explicit purpose", () => {
		const trajectoryLogger = createTrajectoryLogger();
		const query = { search: "trajectory" };

		logProviderFromAction(
			{
				providerName: "facts",
				data: { answer: 42 },
				purpose: "reasoning",
				query,
			},
			trajectoryLogger,
			"trajectory-1",
		);

		expect(trajectoryLogger.logProviderAccess).toHaveBeenCalledWith(
			"step-1",
			expect.objectContaining({ purpose: "reasoning", query }),
		);
	});

	it.each([
		{ providerName: "facts", data: null },
		{ providerName: "facts", data: [] },
		{ providerName: "facts", data: "invalid" },
	])("rejects invalid provider data %#", (context) => {
		expect(() =>
			logProviderFromAction(context, createTrajectoryLogger(), "trajectory-1"),
		).toThrow("Trajectory provider context requires data");
	});
});

describe("provider wrapping", () => {
	it("preserves an async undefined result without context or an active step", async () => {
		const runtimeWithoutContext = createRuntime();
		const runtimeWithoutStep = createRuntime();
		const noStepLogger = createTrajectoryLogger(null);
		const provider = {
			name: "EMPTY_PROVIDER",
			description: "returns no result",
			get: vi.fn(async () => undefined),
		} as unknown as Provider;
		const wrapped = wrapProviderWithLogging(provider, noStepLogger);
		setTrajectoryContext(runtimeWithoutStep, "trajectory-1", noStepLogger);

		await expect(
			wrapped.get(runtimeWithoutContext, createMessage(), createState()),
		).resolves.toBeUndefined();
		await expect(
			wrapped.get(runtimeWithoutStep, createMessage(), createState()),
		).resolves.toBeUndefined();
		expect(provider.get).toHaveBeenCalledTimes(2);
		expect(noStepLogger.logProviderAccess).not.toHaveBeenCalled();
	});

	it("normalizes an undefined result while recording an active step", async () => {
		const runtime = createRuntime();
		const trajectoryLogger = createTrajectoryLogger();
		const wrapped = wrapProviderWithLogging(
			{
				name: "EMPTY_PROVIDER",
				description: "returns no result",
				get: async () => undefined,
			} as unknown as Provider,
			trajectoryLogger,
		);
		setTrajectoryContext(runtime, "trajectory-1", trajectoryLogger);

		await expect(
			wrapped.get(runtime, createMessage(), createState()),
		).resolves.toEqual({ text: "" });
		expect(trajectoryLogger.logProviderAccess).toHaveBeenCalledWith(
			"step-1",
			expect.objectContaining({ data: { text: "", success: true } }),
		);
	});

	it("records provider output and returns the original result", async () => {
		const runtime = createRuntime();
		const trajectoryLogger = createTrajectoryLogger();
		const result = { text: "provider context", values: { count: 2 } };
		const provider = {
			name: "FACT_PROVIDER",
			description: "facts",
			get: async () => result,
		} as Provider;
		const wrapped = wrapProviderWithLogging(provider, trajectoryLogger);
		const state = createState();
		setTrajectoryContext(runtime, "trajectory-1", trajectoryLogger);

		await expect(
			wrapped.get(runtime, createMessage("question"), state),
		).resolves.toBe(result);
		expect(trajectoryLogger.logProviderAccess).toHaveBeenCalledWith("step-1", {
			providerName: "FACT_PROVIDER",
			data: { text: "provider context", success: true },
			purpose: "Provider FACT_PROVIDER accessed for context",
			query: {
				message: "question",
				state: snapshotStateForTrajectory(state),
			},
		});
	});

	it("propagates provider failures without recording a successful access", async () => {
		const runtime = createRuntime();
		const trajectoryLogger = createTrajectoryLogger();
		const failure = new Error("provider failed");
		const wrapped = wrapProviderWithLogging(
			{
				name: "FAIL_PROVIDER",
				description: "fails",
				get: async () => {
					throw failure;
				},
			},
			trajectoryLogger,
		);
		setTrajectoryContext(runtime, "trajectory-1", trajectoryLogger);

		await expect(
			wrapped.get(runtime, createMessage(), createState()),
		).rejects.toBe(failure);
		expect(trajectoryLogger.logProviderAccess).not.toHaveBeenCalled();
	});

	it("returns plugins without providers unchanged and wraps every provider", () => {
		const trajectoryLogger = createTrajectoryLogger();
		const withoutProviders = { name: "empty" } as Plugin;
		const withEmptyProviders = {
			name: "empty-list",
			providers: [],
		} as Plugin;
		const first = {
			name: "FIRST_PROVIDER",
			description: "first",
			get: async () => ({ text: "first" }),
		};
		const second = { ...first, name: "SECOND_PROVIDER" };
		const plugin = {
			name: "provider-plugin",
			description: "metadata",
			providers: [first, second],
		} as Plugin;

		expect(wrapPluginProviders(withoutProviders, trajectoryLogger)).toBe(
			withoutProviders,
		);
		expect(wrapPluginProviders(withEmptyProviders, trajectoryLogger)).toBe(
			withEmptyProviders,
		);
		const wrapped = wrapPluginProviders(plugin, trajectoryLogger);
		expect(wrapped.description).toBe("metadata");
		expect(wrapped.providers).toHaveLength(2);
		expect(wrapped.providers?.[0]).not.toBe(first);
		expect(wrapped.providers?.[1]).not.toBe(second);
	});
});
