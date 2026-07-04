/**
 * Drives executePlannedToolCall end to end: exact action-name matching, strict
 * argument validation and planner-wrapper canonicalization, role/context/
 * connector/private gating (including the ACTION_ROLE_POLICY override),
 * ACTION_STARTED/ACTION_COMPLETED emission with sensitive-result suppression, and
 * trajectory-step wiring; also unit-tests dropEmptyOptionalArgs. Deterministic —
 * stub runtime with vi.fn handlers and in-memory connector storage, no live model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getConnectorAccountManager,
	InMemoryConnectorAccountStorage,
} from "../../connectors/account-manager";
import { runWithStreamingContext } from "../../streaming-context";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
	runWithTrajectoryPurpose,
} from "../../trajectory-context";
import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "../../types";
import { EventType } from "../../types";
import { ModelType } from "../../types/model";
import {
	_resetActionRolePolicyCacheForTests,
	dropEmptyOptionalArgs,
	executePlannedToolCall,
} from "../execute-planned-tool-call";

type ExecuteToolCallTestRuntime = Pick<IAgentRuntime, "actions"> &
	Partial<
		Pick<
			IAgentRuntime,
			| "emitEvent"
			| "getCurrentRunId"
			| "getService"
			| "getServicesByType"
			| "useModel"
		>
	> & {
		logger: Pick<IAgentRuntime["logger"], "debug" | "warn" | "error">;
	};

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		validate: async () => true,
		handler: async () => ({ success: true }),
		...overrides,
	};
}

function makeRuntime(
	actions: Action[],
	overrides: Partial<ExecuteToolCallTestRuntime> = {},
): IAgentRuntime {
	const runtime: ExecuteToolCallTestRuntime = {
		actions,
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		...overrides,
	};
	return runtime as IAgentRuntime;
}

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "hello" },
	} as Memory;
}

describe("executePlannedToolCall", () => {
	it("matches action names exactly only", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const runtime = makeRuntime([makeAction({ name: "DOCUMENT", handler })]);

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "search_documents", params: {} },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Action not found: search_documents");
		expect(handler).not.toHaveBeenCalled();
	});

	it("rejects invalid native tool arguments before invoking the handler", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "CREATE_TASK",
			parameters: [
				{
					name: "title",
					description: "Task title",
					required: true,
					schema: { type: "string" },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "CREATE_TASK", params: { title: 42 } },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain(
			"Argument 'title' expected string, got number",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("drops undeclared planner wrapper args without weakening strict validation", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "op",
					description: "Task operation",
					required: true,
					schema: {
						type: "string",
						enum: ["provision_workspace"],
					},
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "TASKS",
				params: {
					op: "provision_workspace",
					subaction: "provision_workspace",
					thought: "set up workspace",
				},
			},
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { op: "provision_workspace" },
			}),
			undefined,
			undefined,
		);
	});

	it("canonicalizes undeclared subaction into the declared discriminator", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "action",
					description: "Task operation",
					required: false,
					schema: {
						type: "string",
						enum: ["create", "provision_workspace"],
					},
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "TASKS",
				params: {
					subaction: "provision_workspace",
					thought: "set up workspace",
				},
			},
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { action: "provision_workspace" },
			}),
			undefined,
			undefined,
		);
	});

	it("rejects conflicting planner subaction aliases", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "action",
					description: "Task operation",
					required: false,
					schema: {
						type: "string",
						enum: ["create", "provision_workspace"],
					},
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "TASKS",
				params: {
					action: "create",
					subaction: "provision_workspace",
				},
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unexpected argument 'subaction'");
		expect(handler).not.toHaveBeenCalled();
	});

	it("still rejects unknown non-wrapper args", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "CREATE_TASK",
			parameters: [
				{
					name: "title",
					description: "Task title",
					required: true,
					schema: { type: "string" },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "CREATE_TASK",
				params: { title: "Ship it", reciepient: "alice" },
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unexpected argument 'reciepient'");
		expect(handler).not.toHaveBeenCalled();
	});

	it("passes validated parameters and an action-attributing HandlerCallback through to the action handler", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		let handlerCallback: HandlerCallback | undefined;
		const handler = vi.fn(async () => ({ success: true, text: "ok" }));
		const action = makeAction({
			name: "CREATE_TASK",
			parameters: [
				{
					name: "title",
					description: "Task title",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "priority",
					description: "Task priority",
					required: false,
					schema: { type: "string", default: "normal" },
				},
			],
			handler: async (...args) => {
				handlerCallback = args[4];
				return handler(...args);
			},
		});

		await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: { title: "Ship it" } },
		);

		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { title: "Ship it", priority: "normal" },
			}),
			expect.any(Function),
			undefined,
		);
		await handlerCallback?.({ text: "created Ship it" });
		expect(callback).toHaveBeenCalledWith(
			{ text: "created Ship it" },
			"CREATE_TASK",
		);
	});

	it("re-runs validate with extracted parameters before invoking the handler", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const validate = vi.fn(
			async (
				_runtime: unknown,
				_message: unknown,
				_state: unknown,
				options: unknown,
			) => {
				const params = (options as { parameters?: Record<string, unknown> })
					.parameters;
				return params?.op === "unmute";
			},
		);
		const action = makeAction({
			name: "UNMUTE_ROOM",
			parameters: [
				{
					name: "op",
					description: "Operation",
					required: true,
					schema: { type: "string" },
				},
			],
			validate,
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "UNMUTE_ROOM", params: { op: "mute" } },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("not available");
		expect(validate).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({ parameters: { op: "mute" } }),
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("converts thrown handler errors into failure ActionResults", async () => {
		const action = makeAction({
			name: "BOOM",
			handler: async () => {
				throw new Error("handler failed");
			},
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "BOOM", params: {} },
		);

		expect(result).toMatchObject({
			success: false,
			error: "handler failed",
			data: { actionName: "BOOM" },
		});
	});

	it("runs handlers inside an action trajectory step so nested model calls retain purpose context", async () => {
		const observedContexts: ReturnType<typeof getTrajectoryContext>[] = [];
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "action-step-1"),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const useModel = vi.fn(async () => {
			observedContexts.push(getTrajectoryContext());
			return "classified";
		});
		const action = makeAction({
			name: "CLASSIFY_INBOX",
			handler: async (rt) => {
				await rt.useModel(ModelType.TEXT_SMALL, { prompt: "classify" });
				return { success: true };
			},
		});
		const runtime = makeRuntime([action], {
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
			useModel,
		});

		const result = await runWithTrajectoryContext(
			{
				trajectoryId: "trajectory-1",
				trajectoryStepId: "parent-step-1",
				purpose: "planner",
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "CLASSIFY_INBOX", params: {} },
				),
		);

		expect(result.success).toBe(true);
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
			prompt: "classify",
		});
		expect(trajectoryLogger.startStep).toHaveBeenCalledWith(
			"trajectory-1",
			expect.objectContaining({
				timestamp: expect.any(Number),
				agentBalance: 0,
				agentPoints: 0,
				agentPnL: 0,
				openPositions: 0,
			}),
		);
		expect(observedContexts[0]).toMatchObject({
			trajectoryId: "trajectory-1",
			trajectoryStepId: "action-step-1",
			parentStepId: "parent-step-1",
			purpose: "action",
		});
		expect(trajectoryLogger.annotateStep).toHaveBeenCalledWith({
			stepId: "parent-step-1",
			appendChildSteps: ["action-step-1"],
		});
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
	});

	it("rebuilds action trajectory context from message metadata when planner execution lost ALS", async () => {
		const observedContexts: ReturnType<typeof getTrajectoryContext>[] = [];
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "action-step-1"),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const useModel = vi.fn(async () => {
			observedContexts.push(getTrajectoryContext());
			return "classified";
		});
		const action = makeAction({
			name: "INBOX_TRIAGE",
			handler: async (rt) => {
				await runWithTrajectoryPurpose("inbox_triage", () =>
					rt.useModel(ModelType.TEXT_SMALL, { prompt: "classify inbox" }),
				);
				return { success: true };
			},
		});
		const runtime = makeRuntime([action], {
			getCurrentRunId: vi.fn(() => "run-1"),
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
			useModel,
		});
		const message = makeMessage();
		message.metadata = {
			trajectoryId: "trajectory-1",
			trajectoryStepId: "parent-step-1",
		};

		const result = await executePlannedToolCall(
			runtime,
			{ message },
			{ name: "INBOX_TRIAGE", params: {} },
		);

		expect(result.success).toBe(true);
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
			prompt: "classify inbox",
		});
		expect(trajectoryLogger.startStep).toHaveBeenCalledWith(
			"trajectory-1",
			expect.objectContaining({
				timestamp: expect.any(Number),
				agentBalance: 0,
				agentPoints: 0,
				agentPnL: 0,
				openPositions: 0,
			}),
		);
		expect(observedContexts[0]).toMatchObject({
			trajectoryId: "trajectory-1",
			trajectoryStepId: "action-step-1",
			parentStepId: "parent-step-1",
			purpose: "inbox_triage",
			runId: "run-1",
			roomId: "room-id",
			messageId: "message-id",
		});
		expect(trajectoryLogger.annotateStep).toHaveBeenCalledWith({
			stepId: "parent-step-1",
			appendChildSteps: ["action-step-1"],
		});
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
	});

	it("fills a missing trajectory id from message metadata when ALS kept only the parent step", async () => {
		const observedContexts: ReturnType<typeof getTrajectoryContext>[] = [];
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "action-step-1"),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const useModel = vi.fn(async () => {
			observedContexts.push(getTrajectoryContext());
			return "classified";
		});
		const action = makeAction({
			name: "INBOX_TRIAGE",
			handler: async (rt) => {
				await runWithTrajectoryPurpose("inbox_triage", () =>
					rt.useModel(ModelType.TEXT_SMALL, { prompt: "classify inbox" }),
				);
				return { success: true };
			},
		});
		const runtime = makeRuntime([action], {
			getCurrentRunId: vi.fn(() => "run-1"),
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
			useModel,
		});
		const message = makeMessage();
		message.metadata = {
			trajectoryId: "trajectory-1",
			trajectoryStepId: "parent-step-1",
		};

		const result = await runWithTrajectoryContext(
			{
				trajectoryStepId: "parent-step-1",
				purpose: "planner",
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message },
					{ name: "INBOX_TRIAGE", params: {} },
				),
		);

		expect(result.success).toBe(true);
		expect(trajectoryLogger.startStep).toHaveBeenCalledWith(
			"trajectory-1",
			expect.any(Object),
		);
		expect(observedContexts[0]).toMatchObject({
			trajectoryId: "trajectory-1",
			trajectoryStepId: "action-step-1",
			parentStepId: "parent-step-1",
			purpose: "inbox_triage",
			runId: "run-1",
		});
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
	});

	it("emits ACTION_STARTED and ACTION_COMPLETED events for successful planned tools", async () => {
		const emitEvent = vi.fn(async () => {});
		const action = makeAction({
			name: "CREATE_TASK",
			handler: async () => ({
				success: true,
				text: "created",
				data: { id: "task-1" },
			}),
		});
		const runtime = makeRuntime([action], { emitEvent });

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(result.success).toBe(true);
		expect(emitEvent).toHaveBeenNthCalledWith(
			1,
			EventType.ACTION_STARTED,
			expect.objectContaining({
				messageId: "message-id",
				roomId: "room-id",
				world: "room-id",
				content: expect.objectContaining({
					text: "Executing action: CREATE_TASK",
					actions: ["CREATE_TASK"],
					actionStatus: "executing",
				}),
			}),
		);
		expect(emitEvent).toHaveBeenNthCalledWith(
			2,
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				messageId: "message-id",
				roomId: "room-id",
				world: "room-id",
				content: expect.objectContaining({
					text: "created",
					actions: ["CREATE_TASK"],
					actionStatus: "completed",
					actionResult: expect.objectContaining({
						success: true,
						text: "created",
						data: expect.objectContaining({ id: "task-1" }),
					}),
				}),
			}),
		);
	});

	it("suppresses sensitive action result data in ACTION_COMPLETED events", async () => {
		const emitEvent = vi.fn(async () => {});
		const onToolResult = vi.fn();
		const action = makeAction({
			name: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
			suppressActionResultClipboard: true,
			handler: async () => ({
				success: true,
				text: "declared",
				data: {
					actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
					credentialScopeId: "cred_scope_test",
					scopedToken: "secret-token",
				},
			}),
		});
		const runtime = makeRuntime([action], { emitEvent });

		const result = await runWithStreamingContext(
			{ onStreamChunk: vi.fn(), onToolResult },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE", params: {} },
				),
		);

		expect(result).toMatchObject({
			success: true,
			data: expect.objectContaining({ scopedToken: "secret-token" }),
		});
		expect(emitEvent).toHaveBeenNthCalledWith(
			2,
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				content: expect.objectContaining({
					actionResult: expect.objectContaining({
						success: true,
						text: "declared",
						data: {
							actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
							suppressed: true,
							reason: "sensitive_action_result",
						},
					}),
				}),
			}),
		);
		expect(JSON.stringify(emitEvent.mock.calls)).not.toContain("secret-token");
		expect(onToolResult).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({
					data: {
						actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
						suppressed: true,
						reason: "sensitive_action_result",
					},
				}),
				toolCall: expect.objectContaining({
					result: expect.objectContaining({
						data: {
							actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
							suppressed: true,
							reason: "sensitive_action_result",
						},
					}),
				}),
			}),
		);
		expect(JSON.stringify(onToolResult.mock.calls)).not.toContain(
			"secret-token",
		);
	});

	it("emits failed ACTION_COMPLETED events with string errors for thrown handlers", async () => {
		const emitEvent = vi.fn(async () => {});
		const action = makeAction({
			name: "BOOM",
			handler: async () => {
				throw new Error("handler failed");
			},
		});
		const runtime = makeRuntime([action], { emitEvent });

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "BOOM", params: {} },
		);

		expect(result.success).toBe(false);
		expect(emitEvent).toHaveBeenNthCalledWith(
			2,
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				content: expect.objectContaining({
					actions: ["BOOM"],
					actionStatus: "failed",
					actionResult: expect.objectContaining({
						success: false,
						error: "handler failed",
					}),
					error: "handler failed",
				}),
			}),
		);
	});

	it("denies actions that fail role or context gates", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "OWNER_ONLY",
			contextGate: { anyOf: ["admin"] },
			roleGate: { minRole: "OWNER" },
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{
				message: makeMessage(),
				activeContexts: ["general"],
				userRoles: ["MEMBER"],
			},
			{ name: "OWNER_ONLY", params: {} },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("not allowed");
		expect(handler).not.toHaveBeenCalled();
	});

	describe("ACTION_ROLE_POLICY override", () => {
		const ORIGINAL = process.env.ACTION_ROLE_POLICY;
		afterEach(() => {
			if (ORIGINAL === undefined) {
				delete process.env.ACTION_ROLE_POLICY;
			} else {
				process.env.ACTION_ROLE_POLICY = ORIGINAL;
			}
			_resetActionRolePolicyCacheForTests();
		});

		it("allows a context-gated action when policy lists it and caller meets the role", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ GATED: "GUEST" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "GATED", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("rejects a policy-listed action when caller is below the policy role", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ GATED: "ADMIN" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["admin"],
					userRoles: ["GUEST"],
				},
				{ name: "GATED", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("not allowed");
			expect(handler).not.toHaveBeenCalled();
		});

		it("falls through to the normal contextGate when the action is absent from the policy", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ OTHER: "GUEST" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "GATED", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("not allowed");
			expect(handler).not.toHaveBeenCalled();
		});

		it("ignores malformed ACTION_ROLE_POLICY (treats as empty)", async () => {
			process.env.ACTION_ROLE_POLICY = "not-json";
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "PLAIN_ACTION",
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeMessage() },
				{ name: "PLAIN_ACTION", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("does not match a policy entry against the action's similes", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ BASH: "NONE" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "SHELL",
				similes: ["BASH", "EXEC", "RUN_COMMAND"],
				contextGate: { anyOf: ["code", "terminal", "automation"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "SHELL", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("not allowed");
			expect(handler).not.toHaveBeenCalled();
		});

		it("does not let a simile policy entry tighten an unrelated action", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ BASH: "OWNER" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "SHELL",
				similes: ["BASH", "EXEC", "RUN_COMMAND"],
				contextGate: { anyOf: ["general"] },
				roleGate: { minRole: "NONE" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "SHELL", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("ignores policy entries with unrecognized roles instead of granting access", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ GATED: "MODERATOR" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "GATED", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("not allowed");
			expect(handler).not.toHaveBeenCalled();
		});
	});

	it("denies execution when connector account policy is not satisfied", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "SEND_CONNECTOR_MESSAGE",
			connectorAccountPolicy: {
				provider: "gmail",
				roles: ["owner"],
				purposes: ["messaging"],
				accessGates: ["open"],
				accountIdParam: "accountId",
			},
			parameters: [
				{
					name: "accountId",
					description: "Connector account id",
					required: true,
					schema: { type: "string" },
				},
			],
			handler,
		});
		const runtime = makeRuntime([action]);
		const storage = new InMemoryConnectorAccountStorage();
		const manager = getConnectorAccountManager(runtime, storage);
		await manager.upsertAccount("gmail", {
			id: "member-account",
			role: "member",
			purpose: "messaging",
			accessGate: "open",
			status: "connected",
		});

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{
				name: "SEND_CONNECTOR_MESSAGE",
				params: { accountId: "member-account" },
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("role TEAM is not allowed");
		expect(handler).not.toHaveBeenCalled();
	});

	it("does not trust content.metadata.accountId for connector account selection", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "SEND_CONNECTOR_MESSAGE",
			connectorAccountPolicy: {
				provider: "gmail",
				roles: ["owner"],
				purposes: ["messaging"],
				accessGates: ["open"],
				accountIdParam: "accountId",
			},
			handler,
		});
		const runtime = makeRuntime([action]);
		const storage = new InMemoryConnectorAccountStorage();
		const manager = getConnectorAccountManager(runtime, storage);
		await manager.upsertAccount("gmail", {
			id: "owner-account",
			role: "owner",
			purpose: "messaging",
			accessGate: "open",
			status: "connected",
		});
		const message = {
			...makeMessage(),
			content: {
				text: "send this",
				metadata: { accountId: "owner-account" },
			},
		} as Memory;

		const result = await executePlannedToolCall(
			runtime,
			{ message },
			{ name: "SEND_CONNECTOR_MESSAGE", params: {} },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain(
			"Missing connector account parameter",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	describe("private actions", () => {
		function makeAutonomousMessage(): Memory {
			return {
				...makeMessage(),
				content: {
					text: "autonomous tick",
					metadata: { isAutonomous: true },
				},
			} as Memory;
		}

		it("rejects a private action on a user-driven turn", async () => {
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "MINT_COIN",
				private: true,
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeMessage() },
				{ name: "MINT_COIN", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain(
				"is private and can only run in the agent's autonomous loop",
			);
			expect(handler).not.toHaveBeenCalled();
		});

		it("allows a private action on an autonomous turn", async () => {
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "MINT_COIN",
				private: true,
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeAutonomousMessage() },
				{ name: "MINT_COIN", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("leaves non-private actions runnable on user turns", async () => {
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({ name: "REPLY", handler });

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeMessage() },
				{ name: "REPLY", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});
	});
});

describe("dropEmptyOptionalArgs", () => {
	function backgroundLikeAction(
		handler: Action["handler"] = async () => ({ success: true }),
	): Action {
		// Mirrors the #10694 live-trajectory shape: an all-optional action where
		// strict tool schemas force the model to emit every key, so `""` is its
		// only way to leave `preset` unset on a color-only turn.
		return makeAction({
			name: "BACKGROUND",
			parameters: [
				{
					name: "op",
					description: "Operation",
					required: false,
					schema: { type: "string", enum: ["set", "undo", "redo", "reset"] },
				},
				{
					name: "color",
					description: "Color",
					required: false,
					schema: { type: "string" },
				},
				{
					name: "preset",
					description: "Shader preset",
					required: false,
					schema: { type: "string", enum: ["aurora", "lava"] },
				},
			],
			handler,
		});
	}

	it("treats an empty string on an optional enum parameter as omitted (#10694)", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = backgroundLikeAction(handler);

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "BACKGROUND", params: { op: "set", color: "teal", preset: "" } },
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { op: "set", color: "teal" },
			}),
			undefined,
			undefined,
		);
	});

	it("keeps an empty string on a REQUIRED enum parameter failing loudly", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "op",
					description: "Task operation",
					required: true,
					schema: { type: "string", enum: ["create", "provision_workspace"] },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "TASKS", params: { op: "" } },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("is not one of");
		expect(handler).not.toHaveBeenCalled();
	});

	it("drops only empty-string optional keys and returns the same object when nothing matches", () => {
		const action = backgroundLikeAction();

		const untouched = { op: "set", color: "teal" };
		expect(dropEmptyOptionalArgs(action, untouched)).toBe(untouched);

		expect(
			dropEmptyOptionalArgs(action, { op: "set", color: "", preset: "" }),
		).toEqual({ op: "set" });

		// Undeclared keys and non-string empties pass through untouched — strict
		// validation still owns rejecting them.
		expect(
			dropEmptyOptionalArgs(action, { op: "set", stray: "", count: 0 }),
		).toEqual({ op: "set", stray: "", count: 0 });
	});
});
