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
	MessageConnectorManageServerAuthorization,
	UUID,
} from "../../../types/index.ts";
import { stringToUuid } from "../../../utils.ts";
import { inferOp, messageAction } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-0000000000bb";
const SENDER_ID = "00000000-0000-0000-0000-0000000000cc";
const LINKED_ID = "00000000-0000-0000-0000-0000000000dd";
const DESTINATION_WORLD_ID = "00000000-0000-0000-0000-0000000000ee";
const DESTINATION_ROOM_ID = "00000000-0000-0000-0000-0000000000ff";
const ACCOUNT_ID = "primary";

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
	authorization: MessageConnectorManageServerAuthorization;
	params?: Record<string, unknown>;
};

function harness(options?: {
	handler?: (
		params: ManageCall,
	) => Promise<{ summary: string; data?: Record<string, unknown> }>;
	omitHandler?: boolean;
	authorizedEntityId?: UUID | null;
	includeBinding?: boolean;
	resolverAccountId?: string;
	verifiedRelatedEntityIds?: UUID[];
}) {
	let activeServerId = "123456789012345678";
	const authorizedEntityId =
		options?.authorizedEntityId === undefined
			? (SENDER_ID as UUID)
			: options.authorizedEntityId;
	const calls: ManageCall[] = [];
	const manageServerHandler = options?.omitHandler
		? undefined
		: vi.fn(
				async (
					_runtime: IAgentRuntime,
					params: {
						operation: string;
						serverId?: string;
						authorization: MessageConnectorManageServerAuthorization;
						params?: Record<string, unknown>;
					},
				) => {
					const call = {
						operation: params.operation,
						serverId: params.serverId,
						authorization: params.authorization,
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
				accountId: ACCOUNT_ID,
				label: "Discord",
				capabilities: ["manage_server"],
				supportedTargetKinds: ["channel"],
				contexts: [],
				resolveManageServerDestination: async (_runtime, params) => {
					activeServerId = params.serverId;
					const accountId = options?.resolverAccountId ?? ACCOUNT_ID;
					return {
						source: "discord",
						accountId,
						serverId: activeServerId,
						messageServerId: stringToUuid(activeServerId),
						destinationWorldId: DESTINATION_WORLD_ID as UUID,
						target: {
							source: "discord",
							accountId,
							serverId: activeServerId,
						},
					};
				},
				...(manageServerHandler ? { manageServerHandler } : {}),
			},
		],
		getWorld: async (worldId: UUID) =>
			worldId === DESTINATION_WORLD_ID
				? {
						id: DESTINATION_WORLD_ID as UUID,
						agentId: AGENT_ID as UUID,
						messageServerId: stringToUuid(activeServerId),
						metadata: authorizedEntityId
							? {
									roles: { [authorizedEntityId]: "ADMIN" },
									roleSources: { [authorizedEntityId]: "manual" },
								}
							: {},
					}
				: null,
		getRooms: async (worldId: UUID) =>
			worldId === DESTINATION_WORLD_ID && options?.includeBinding !== false
				? [
						{
							id: DESTINATION_ROOM_ID as UUID,
							worldId: DESTINATION_WORLD_ID as UUID,
							agentId: AGENT_ID as UUID,
							source: "discord",
							type: "GROUP",
							serverId: activeServerId,
							messageServerId: stringToUuid(activeServerId),
						},
					]
				: [],
		getRoomsForParticipant: async (entityId: UUID) =>
			entityId === AGENT_ID || entityId === authorizedEntityId
				? [DESTINATION_ROOM_ID as UUID]
				: [],
		getService: (serviceType: string) =>
			serviceType === "relationships" && options?.verifiedRelatedEntityIds
				? ({
						getVerifiedMemberEntityIds: async () =>
							options.verifiedRelatedEntityIds ?? [],
					} as never)
				: null,
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

	it("denies a source-world ADMIN turn targeting an unauthorized world B", async () => {
		// The outer MESSAGE action role gate has already admitted this turn as an
		// ADMIN in world A. This contract test starts at its manage_server handler
		// and proves that source authority is not reused for destination world B.
		const { runtime, calls } = harness({ authorizedEntityId: null });
		const result = await invoke(runtime, {
			action: "delete_channel",
			source: "discord",
			accountId: ACCOUNT_ID,
			serverId: "223456789012345678",
			channelId: "323456789012345678",
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
		expect(calls).toHaveLength(0);
	});

	it("allows a verified linked identity that is ADMIN and a member in world B", async () => {
		const { runtime, calls } = harness({
			authorizedEntityId: LINKED_ID as UUID,
			verifiedRelatedEntityIds: [LINKED_ID as UUID],
		});
		const result = await invoke(runtime, {
			action: "create_channel",
			source: "discord",
			accountId: ACCOUNT_ID,
			serverId: "223456789012345678",
			name: "linked-admin",
		});
		expect(result.success).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.authorization).toMatchObject({
			requesterEntityId: SENDER_ID,
			authorizedEntityId: LINKED_ID,
			role: "ADMIN",
			destinationWorldId: DESTINATION_WORLD_ID,
		});
	});

	it("fails closed when the exact destination room binding is missing", async () => {
		const { runtime, calls } = harness({ includeBinding: false });
		const result = await invoke(runtime, {
			action: "create_role",
			source: "discord",
			accountId: ACCOUNT_ID,
			serverId: "223456789012345678",
			name: "ops",
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("MANAGE_SERVER_DESTINATION_UNBOUND");
		expect(calls).toHaveLength(0);
	});

	it("rejects a resolver result for a different selected account", async () => {
		const { runtime, calls } = harness({ resolverAccountId: "secondary" });
		const result = await invoke(runtime, {
			action: "create_channel",
			source: "discord",
			accountId: ACCOUNT_ID,
			serverId: "223456789012345678",
			name: "wrong-account",
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("DESTINATION_CONNECTOR_MISMATCH");
		expect(calls).toHaveLength(0);
	});
});
