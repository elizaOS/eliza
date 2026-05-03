/**
 * Coverage for the private `runPostActionContinuation` loop in
 * `DefaultMessageService` (`services/message.ts:~5104-5347`). Drives the loop
 * via prototype access so we do not have to spin up the full
 * `handleMessage` setup; collaborators are stubbed at the runtime + service
 * boundary.
 *
 * Covers the five break conditions called out in review #4:
 *   1. simple-mode break
 *   2. confirmation break (`requiresConfirmation` flag)
 *   3. confirmation break (typed `ActionConfirmationStatus` error code)
 *   4. no-new-results break
 *   5. max-iteration cap
 *   6. gate-recheck break (`suppressPostActionContinuation`)
 *   7. mode "none" early break
 *
 * The loop's control flow is intentionally untouched. These tests pin it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultMessageService } from "../services/message.ts";
import type {
	Action,
	ActionResult,
	Content,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../types";

const MESSAGE_ID = "11111111-2222-3333-4444-555555555555" as UUID;
const ROOM_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as UUID;
const ENTITY_ID = "ffffffff-1111-2222-3333-444444444444" as UUID;
const AGENT_ID = "55555555-6666-7777-8888-999999999999" as UUID;

interface RuntimeStubs {
	actions: Action[];
	getActionResultsImpl?: (id: UUID) => ActionResult[];
	processActionsImpl?: (
		message: Memory,
		responses: Memory[],
		state: State,
		cb: HandlerCallback,
	) => Promise<void>;
}

function buildMessage(): Memory {
	return {
		id: MESSAGE_ID,
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "hello", source: "test" },
		createdAt: Date.now(),
	};
}

function buildState(): State {
	return {
		values: {},
		data: {},
		text: "",
	};
}

function buildAction(
	name: string,
	overrides: Partial<Pick<Action, "suppressPostActionContinuation">> = {},
): Action {
	return {
		name,
		description: name,
		validate: async () => true,
		handler: async () => undefined,
		...overrides,
	};
}

function buildOpts(maxMultiStepIterations: number) {
	return {
		maxRetries: 1,
		timeoutDuration: 1000,
		useMultiStep: false,
		maxMultiStepIterations,
		continueAfterActions: true,
		keepExistingResponses: false,
		shouldRespondModel: "response-handler",
	} as unknown as Parameters<
		DefaultMessageService["runPostActionContinuation"]
	>[4];
}

const noopLogger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
};

function buildRuntime(stubs: RuntimeStubs): IAgentRuntime {
	const composedState: State = buildState();
	const getActionResults = vi.fn(
		stubs.getActionResultsImpl ?? (() => [] as ActionResult[]),
	);
	const processActions = vi.fn(
		stubs.processActionsImpl ?? (async () => undefined),
	);
	return {
		agentId: AGENT_ID,
		actions: stubs.actions,
		logger: noopLogger,
		character: { templates: {} },
		composeState: vi.fn(async () => composedState),
		getActionResults,
		processActions,
		createMemory: vi.fn(async () => undefined),
		applyPipelineHooks: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		getService: vi.fn(() => null),
		getSetting: vi.fn(() => undefined),
	} as unknown as IAgentRuntime;
}

/**
 * Stubs the private `runSingleShotCore` to return a controlled sequence of
 * StrategyResults. Each call consumes the next entry; if the queue runs dry
 * the test fails loudly.
 */
function stubSingleShot(
	service: DefaultMessageService,
	queue: Array<{
		responseContent: Content | null;
		mode: "simple" | "actions" | "none";
		responseMessages?: Memory[];
	}>,
): { calls: { count: number } } {
	let i = 0;
	const calls = { count: 0 };
	(service as unknown as Record<string, unknown>).runSingleShotCore =
		async function () {
			calls.count++;
			const next = queue[i++];
			if (!next) {
				throw new Error(
					`runSingleShotCore stub exhausted after ${calls.count} calls`,
				);
			}
			return {
				responseContent: next.responseContent,
				responseMessages: next.responseMessages ?? [],
				state: buildState(),
				mode: next.mode,
			};
		};
	return { calls };
}

function callRunPostActionContinuation(
	service: DefaultMessageService,
	runtime: IAgentRuntime,
	message: Memory,
	state: State,
	opts: ReturnType<typeof buildOpts>,
	initialActionResults: ActionResult[],
	callback: HandlerCallback | undefined = undefined,
) {
	return (
		service as unknown as {
			runPostActionContinuation: (
				runtime: IAgentRuntime,
				message: Memory,
				state: State,
				cb: HandlerCallback | undefined,
				opts: ReturnType<typeof buildOpts>,
				initialActionResults: ActionResult[],
			) => Promise<{
				mode: "simple" | "actions" | "none";
				responseContent: Content | null;
			}>;
		}
	).runPostActionContinuation(
		runtime,
		message,
		state,
		callback,
		opts,
		initialActionResults,
	);
}

describe("runPostActionContinuation break conditions", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("simple mode: emits one reply then breaks without re-entering the loop", async () => {
		const runtime = buildRuntime({ actions: [buildAction("LOOK_UP_ORDER")] });
		const service = new DefaultMessageService();

		const replyContent: Content = {
			text: "All set.",
			actions: ["REPLY"],
			simple: true,
		};
		const { calls } = stubSingleShot(service, [
			{
				responseContent: replyContent,
				mode: "simple",
				responseMessages: [
					{
						id: "00000000-0000-0000-0000-000000000001" as UUID,
						entityId: AGENT_ID,
						agentId: AGENT_ID,
						roomId: ROOM_ID,
						content: replyContent,
					},
				],
			},
		]);

		const callback = vi.fn(async () => []);

		const result = await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(6),
			[{ success: true, data: { orderId: "abc" } }],
			callback as unknown as HandlerCallback,
		);

		expect(result.mode).toBe("simple");
		expect(calls.count).toBe(1);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(runtime.processActions).not.toHaveBeenCalled();
	});

	it("none mode: breaks immediately without invoking processActions", async () => {
		const runtime = buildRuntime({ actions: [buildAction("LOOK_UP_ORDER")] });
		const service = new DefaultMessageService();

		const stopContent: Content = {
			text: "",
			actions: ["STOP"],
		};
		const { calls } = stubSingleShot(service, [
			{ responseContent: stopContent, mode: "none" },
		]);

		const result = await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(6),
			[{ success: true }],
		);

		expect(result.mode).toBe("simple"); // wrapper sets mode based on responseContent
		expect(calls.count).toBe(1);
		expect(runtime.processActions).not.toHaveBeenCalled();
	});

	it("confirmation break: action returns requiresConfirmation:true, loop exits", async () => {
		const actions = [buildAction("OWNER_SEND_MESSAGE")];
		let actionResults: ActionResult[] = [];
		const runtime = buildRuntime({
			actions,
			getActionResultsImpl: () => actionResults,
			processActionsImpl: async () => {
				actionResults = [
					{
						success: false,
						values: { requiresConfirmation: true },
					},
				];
			},
		});
		const service = new DefaultMessageService();

		const actionContent: Content = {
			text: "",
			actions: ["OWNER_SEND_MESSAGE"],
		};
		const { calls } = stubSingleShot(service, [
			{ responseContent: actionContent, mode: "actions" },
			// If the loop did not break, this would be consumed and the assertion
			// `calls.count === 1` would fail.
			{ responseContent: actionContent, mode: "actions" },
		]);

		await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(6),
			[{ success: true }],
		);

		expect(calls.count).toBe(1);
		expect(runtime.processActions).toHaveBeenCalledTimes(1);
	});

	it("confirmation break: action returns ActionConfirmationStatus error code", async () => {
		const actions = [buildAction("OWNER_SEND_MESSAGE")];
		let actionResults: ActionResult[] = [];
		const runtime = buildRuntime({
			actions,
			getActionResultsImpl: () => actionResults,
			processActionsImpl: async () => {
				actionResults = [
					{
						success: false,
						data: { error: "AWAITING_CONFIRMATION" },
					},
				];
			},
		});
		const service = new DefaultMessageService();

		const actionContent: Content = {
			text: "",
			actions: ["OWNER_SEND_MESSAGE"],
		};
		const { calls } = stubSingleShot(service, [
			{ responseContent: actionContent, mode: "actions" },
			{ responseContent: actionContent, mode: "actions" },
		]);

		await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(6),
			[{ success: true }],
		);

		expect(calls.count).toBe(1);
	});

	it("no-new-results break: processActions writes nothing, loop exits with warn log", async () => {
		const actions = [buildAction("LOOK_UP_ORDER")];
		const runtime = buildRuntime({
			actions,
			getActionResultsImpl: () => [], // never produces new results
		});
		const service = new DefaultMessageService();

		const actionContent: Content = {
			text: "",
			actions: ["LOOK_UP_ORDER"],
		};
		const { calls } = stubSingleShot(service, [
			{ responseContent: actionContent, mode: "actions" },
			{ responseContent: actionContent, mode: "actions" },
		]);

		await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(6),
			[{ success: true }],
		);

		expect(calls.count).toBe(1);
		expect(runtime.processActions).toHaveBeenCalledTimes(1);
		expect(runtime.logger.warn).toHaveBeenCalled();
	});

	it("gate-recheck break: action with suppressPostActionContinuation exits after one iteration", async () => {
		const actions = [
			buildAction("PHONE_OWNER", { suppressPostActionContinuation: true }),
		];
		let actionResults: ActionResult[] = [];
		const runtime = buildRuntime({
			actions,
			getActionResultsImpl: () => actionResults,
			processActionsImpl: async () => {
				actionResults = [{ success: true, data: { phoned: true } }];
			},
		});
		const service = new DefaultMessageService();

		const actionContent: Content = {
			text: "",
			actions: ["PHONE_OWNER"],
		};
		const { calls } = stubSingleShot(service, [
			{ responseContent: actionContent, mode: "actions" },
			{ responseContent: actionContent, mode: "actions" },
		]);

		await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(6),
			[{ success: true }],
		);

		expect(calls.count).toBe(1);
		expect(runtime.processActions).toHaveBeenCalledTimes(1);
	});

	it("max-iteration cap: stops at exactly maxMultiStepIterations even if planner keeps requesting actions", async () => {
		const actions = [buildAction("LOOK_UP_ORDER")];
		// processActions keeps producing fresh action results so the
		// no-new-results guard never trips — only the for-loop cap can.
		let counter = 0;
		const runtime = buildRuntime({
			actions,
			getActionResultsImpl: () => [
				{ success: true, data: { iteration: counter } },
			],
			processActionsImpl: async () => {
				counter++;
			},
		});
		const service = new DefaultMessageService();

		const actionContent: Content = {
			text: "",
			actions: ["LOOK_UP_ORDER"],
		};
		const cap = 2;
		const queue = Array.from({ length: cap + 5 }, () => ({
			responseContent: actionContent,
			mode: "actions" as const,
		}));
		const { calls } = stubSingleShot(service, queue);

		await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(cap),
			[{ success: true }],
		);

		expect(calls.count).toBe(cap);
		expect(runtime.processActions).toHaveBeenCalledTimes(cap);
	});

	it("returns early without calling runSingleShotCore when message.id is absent", async () => {
		const runtime = buildRuntime({ actions: [buildAction("LOOK_UP_ORDER")] });
		const service = new DefaultMessageService();
		const { calls } = stubSingleShot(service, []);

		const noIdMessage: Memory = { ...buildMessage(), id: undefined };
		const result = await callRunPostActionContinuation(
			service,
			runtime,
			noIdMessage,
			buildState(),
			buildOpts(6),
			[{ success: true }],
		);

		expect(calls.count).toBe(0);
		expect(result.mode).toBe("none");
	});

	it("returns early without calling runSingleShotCore when initialActionResults is empty", async () => {
		const runtime = buildRuntime({ actions: [buildAction("LOOK_UP_ORDER")] });
		const service = new DefaultMessageService();
		const { calls } = stubSingleShot(service, []);

		const result = await callRunPostActionContinuation(
			service,
			runtime,
			buildMessage(),
			buildState(),
			buildOpts(6),
			[],
		);

		expect(calls.count).toBe(0);
		expect(result.mode).toBe("none");
	});
});
