/**
 * Covers MESSAGE op=manage_server routing: operation normalization from the
 * action-alias surface, connector selection by manageServerHandler hook,
 * bounded param forwarding, NOT_SUPPORTED / missing-operation failures, and
 * connector-thrown gate errors surfacing as structured action failures.
 * Deterministic mock runtime and connectors — no live model, no DB.
 */

import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
} from "../../../types/index.ts";
import { inferOp, messageAction } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-0000000000bb";
const SENDER_ID = "00000000-0000-0000-0000-0000000000cc";

const baseMessage = {
	id: "00000000-0000-0000-0000-0000000000aa",
	roomId: ROOM_ID,
	entityId: SENDER_ID,
	agentId: AGENT_ID,
	content: { text: "set up the server", source: "discord" },
	createdAt: 1,
} as unknown as Memory;

type ManageCall = {
	operation: string;
	serverId?: string;
	params?: Record<string, unknown>;
};

function harness(options?: {
	handler?: (
		params: ManageCall,
	) => Promise<{ summary: string; data?: Record<string, unknown> }>;
	omitHandler?: boolean;
}) {
	const calls: ManageCall[] = [];
	const manageServerHandler = options?.omitHandler
		? undefined
		: vi.fn(
				async (
					_runtime: IAgentRuntime,
					params: {
						operation: string;
						serverId?: string;
						params?: Record<string, unknown>;
					},
				) => {
					const call = {
						operation: params.operation,
						serverId: params.serverId,
						params: params.params,
					};
					calls.push(call);
					if (options?.handler) return options.handler(call);
					return { summary: `did ${params.operation}` };
				},
			);
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		getMessageConnectors: () => [
			{
				source: "discord",
				label: "Discord",
				capabilities: ["manage_server"],
				supportedTargetKinds: ["channel"],
				contexts: [],
				...(manageServerHandler ? { manageServerHandler } : {}),
			},
		],
		reportError: () => undefined,
	});
	return { runtime, calls, manageServerHandler };
}

async function invoke(
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
): Promise<ActionResult> {
	const result = await messageAction.handler(
		runtime,
		baseMessage,
		undefined,
		{ parameters: params },
		undefined,
		undefined,
	);
	if (!result) throw new Error("handler returned no result");
	return result as ActionResult;
}

describe("MESSAGE op inference for manage_server", () => {
	it("maps the manage_server op and its verb aliases", () => {
		expect(inferOp({ action: "manage_server" })).toBe("manage_server");
		expect(inferOp({ action: "create_channel" })).toBe("manage_server");
		expect(inferOp({ action: "create_role" })).toBe("manage_server");
		expect(inferOp({ action: "apply_template" })).toBe("manage_server");
		expect(inferOp({ action: "kick_member" })).toBe("manage_server");
		expect(inferOp({ action: "guild_management" })).toBe("manage_server");
	});

	it("does not shadow existing ops", () => {
		expect(inferOp({ action: "send" })).toBe("send");
		expect(inferOp({ action: "manage" })).toBe("manage");
		expect(inferOp({ action: "react" })).toBe("react");
	});
});

describe("MESSAGE op=manage_server routing", () => {
	it("forwards an explicit operation with bounded params to the connector", async () => {
		const { runtime, calls } = harness();
		const result = await invoke(runtime, {
			action: "manage_server",
			source: "discord",
			operation: "create_channel",
			serverId: "1234567890",
			name: "alerts",
			topic: "CI alerts",
			channelType: "text",
			parentId: "999",
			dryRun: false,
			// Unknown params must NOT be forwarded.
			token: "should-not-forward",
		});
		expect(result.success).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.operation).toBe("create_channel");
		expect(calls[0]?.serverId).toBe("1234567890");
		expect(calls[0]?.params).toMatchObject({
			name: "alerts",
			topic: "CI alerts",
			channelType: "text",
			parentId: "999",
		});
		expect(calls[0]?.params).not.toHaveProperty("token");
		expect(result.text).toBe("did create_channel");
	});

	it("derives the operation from an aliased action string", async () => {
		const { runtime, calls } = harness();
		const result = await invoke(runtime, {
			action: "create_role",
			source: "discord",
			serverId: "1234567890",
			name: "Dev",
			permissions: ["ViewChannel", "SendMessages"],
		});
		expect(result.success).toBe(true);
		expect(calls[0]?.operation).toBe("create_role");
		expect(calls[0]?.params?.permissions).toEqual([
			"ViewChannel",
			"SendMessages",
		]);
	});

	it("renames moderation aliases to the connector verbs", async () => {
		const { runtime, calls } = harness();
		await invoke(runtime, {
			action: "kick_member",
			source: "discord",
			serverId: "1234567890",
			userId: "555",
		});
		expect(calls[0]?.operation).toBe("kick");
	});

	it("fails with INVALID_PARAMETERS when no operation can be derived", async () => {
		const { runtime, calls } = harness();
		const result = await invoke(runtime, {
			action: "manage_server",
			source: "discord",
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("INVALID_PARAMETERS");
		expect(calls).toHaveLength(0);
	});

	it("fails when no connector supports server management", async () => {
		const { runtime } = harness({ omitHandler: true });
		const result = await invoke(runtime, {
			action: "manage_server",
			source: "discord",
			operation: "create_channel",
			name: "general",
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("NO_CONNECTORS_REGISTERED");
	});

	it("surfaces connector gate denials as structured failures", async () => {
		const { runtime } = harness({
			handler: async () => {
				throw new Error(
					"Discord create_channel is disabled: config gate actions.channels must be explicitly enabled in the Discord connector settings.",
				);
			},
		});
		const result = await invoke(runtime, {
			action: "manage_server",
			source: "discord",
			operation: "create_channel",
			serverId: "1234567890",
			name: "general",
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("MESSAGE_MANAGE_SERVER_FAILED");
		expect(result.text).toContain("actions.channels");
	});

	it("returns the connector receipt in the action result data", async () => {
		const { runtime } = harness({
			handler: async () => ({
				summary: "Applied template",
				data: {
					entries: [{ kind: "channel", action: "created", name: "general" }],
				},
			}),
		});
		const result = await invoke(runtime, {
			action: "apply_template",
			source: "discord",
			serverId: "1234567890",
			template: "project-team",
		});
		expect(result.success).toBe(true);
		expect(result.data?.receipt).toMatchObject({
			entries: [{ kind: "channel", action: "created", name: "general" }],
		});
		expect(result.data?.operation).toBe("apply_template");
	});
});
