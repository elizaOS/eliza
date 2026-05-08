import { describe, expect, it, vi } from "vitest";
import {
	getConnectorAccountManager,
	InMemoryConnectorAccountStorage,
} from "../../connectors/account-manager";
import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "../../types";
import { executePlannedToolCall } from "../execute-planned-tool-call";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		validate: async () => true,
		handler: async () => ({ success: true }),
		...overrides,
	};
}

function makeRuntime(actions: Action[]): IAgentRuntime {
	return {
		actions,
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
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

	it("passes validated parameters and HandlerCallback through to the action handler", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
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
			handler,
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
			callback,
			undefined,
		);
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
});
