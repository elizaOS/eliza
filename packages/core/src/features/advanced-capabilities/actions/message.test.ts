/**
 * Covers the MESSAGE action: the list_connections cross-connector roster, the
 * op=send owner-binding gate, and i18n-safe op inference (#10471). Uses
 * createMockRuntime with deterministic mock connectors — no live model, no DB.
 */

import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	SendHandlerOutcome,
	SendHandlerReceipt,
	SendHandlerResult,
} from "../../../types/index.ts";
import { inferOp, messageAction } from "./message.ts";

function mockConnector(
	source: string,
	label: string,
	rooms: string[],
	accountId?: string,
) {
	return {
		source,
		label,
		accountId,
		capabilities: [],
		supportedTargetKinds: [],
		contexts: [],
		listRooms: async () =>
			rooms.map((name) => ({
				target: { source },
				label: name,
				kind: "room" as const,
				score: 0.5,
				contexts: [],
			})),
	};
}

function mockRuntime(connectors: unknown[]): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-000000000001",
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		getMessageConnectors: () => connectors,
	} as unknown as IAgentRuntime;
}

const message = {
	id: "00000000-0000-0000-0000-0000000000aa",
	roomId: "00000000-0000-0000-0000-0000000000bb",
	entityId: "00000000-0000-0000-0000-0000000000cc",
	agentId: "00000000-0000-0000-0000-000000000001",
	content: { text: "what platforms are you connected to?", source: "matrix" },
	createdAt: 1,
} as unknown as Memory;

describe("MESSAGE explicit operation validation", () => {
	it("accepts a structurally invoked operation without inferred chat context", async () => {
		const valid = await messageAction.validate(
			mockRuntime([]),
			message,
			undefined,
			{ parameters: { action: "read_with_contact" } },
		);
		expect(valid).toBe(true);
	});
});

async function listConnections(runtime: IAgentRuntime): Promise<ActionResult> {
	const result = await messageAction.handler(
		runtime,
		message,
		undefined,
		{ parameters: { action: "list_connections" } },
		undefined,
		undefined,
	);
	if (!result) throw new Error("handler returned no result");
	return result;
}

describe("MESSAGE op=list_connections", () => {
	it("lists every connected platform cross-connector with room counts", async () => {
		const runtime = mockRuntime([
			mockConnector("discord", "Discord", ["#general", "#dev", "#random"]),
			mockConnector("matrix", "Matrix", ["Shape Rotator", "Announcements"]),
		]);
		const result = await listConnections(runtime);
		const data = result.data as {
			operation: string;
			connectionCount: number;
			connections: { platform: string; roomCount: number }[];
		};
		expect(result.success).toBe(true);
		expect(data.operation).toBe("list_connections");
		expect(data.connectionCount).toBe(2);
		expect(data.connections.map((c) => c.platform).sort()).toEqual([
			"discord",
			"matrix",
		]);
		expect(
			data.connections.find((c) => c.platform === "discord")?.roomCount,
		).toBe(3);
		expect(
			data.connections.find((c) => c.platform === "matrix")?.roomCount,
		).toBe(2);
		// the summary mentions both platform labels
		expect(result.text).toContain("Discord");
		expect(result.text).toContain("Matrix");
	});

	it("dedupes the source-only routing fallback when a per-account entry exists", async () => {
		// Same source: a source-only fallback (no accountId) plus the real
		// per-account connector. Only the per-account entry should be listed.
		const runtime = mockRuntime([
			mockConnector("discord", "Discord", ["#general"]),
			mockConnector("discord", "Discord", ["#general", "#dev"], "default"),
			mockConnector("matrix", "Matrix", ["Shape Rotator"], "default"),
		]);
		const result = await listConnections(runtime);
		const data = result.data as {
			connectionCount: number;
			connections: {
				platform: string;
				accountId?: string;
				roomCount: number;
			}[];
		};
		const discord = data.connections.filter((c) => c.platform === "discord");
		expect(discord).toHaveLength(1);
		// the listed entry is the per-account connector (2 rooms), not the fallback
		expect(discord[0].accountId).toBe("default");
		expect(discord[0].roomCount).toBe(2);
		expect(data.connectionCount).toBe(2);
	});

	it("a failing connector appears as unavailable, distinguishable from a genuinely-empty one", async () => {
		// "Not loaded must never read as zero": a connector whose listRooms throws
		// must carry an explicit error state (roomCount null + error), while a
		// connector that really has zero rooms reports roomCount 0 with no error.
		const broken = {
			source: "x",
			label: "X",
			capabilities: [],
			supportedTargetKinds: [],
			contexts: [],
			listRooms: async () => {
				throw new Error("connector offline");
			},
		};
		const runtime = mockRuntime([
			broken,
			mockConnector("discord", "Discord", ["#general"]),
			mockConnector("matrix", "Matrix", []),
		]);
		const result = await listConnections(runtime);
		const data = result.data as {
			connections: {
				platform: string;
				roomCount: number | null;
				mutedRoomCount: number | null;
				error?: string;
			}[];
		};
		const x = data.connections.find((c) => c.platform === "x");
		expect(x).toBeDefined();
		expect(x?.roomCount).toBeNull();
		expect(x?.mutedRoomCount).toBeNull();
		expect(x?.error).toContain("connector offline");
		// the summary flags the broken connector, not just the data payload
		expect(result.text).toContain("X (unavailable)");
		// healthy connectors in the same roster keep their real counts
		const discord = data.connections.find((c) => c.platform === "discord");
		expect(discord?.roomCount).toBe(1);
		expect(discord?.error).toBeUndefined();
		// genuinely empty is a real zero, NOT an error state
		const matrix = data.connections.find((c) => c.platform === "matrix");
		expect(matrix?.roomCount).toBe(0);
		expect(matrix?.error).toBeUndefined();
		expect(result.text).not.toContain("Matrix (unavailable)");
	});

	it("bounds the roster at 8 connectors", async () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			mockConnector(`platform-${i}`, `Platform ${i}`, ["#room"]),
		);
		const runtime = mockRuntime(many);
		const result = await listConnections(runtime);
		const data = result.data as {
			connectionCount: number;
			connections: unknown[];
		};
		expect(data.connections.length).toBe(8);
		expect(data.connectionCount).toBe(8);
	});

	it("returns zero platforms when no connector exposes listRooms", async () => {
		const runtime = mockRuntime([
			{
				source: "x",
				label: "X",
				capabilities: [],
				supportedTargetKinds: [],
				contexts: [],
			},
		]);
		const result = await listConnections(runtime);
		const data = result.data as { connectionCount: number };
		expect(data.connectionCount).toBe(0);
	});

	it("does not misroute a bare connection-themed message (no explicit action)", async () => {
		// Locks the no-free-text-route invariant: a message merely mentioning
		// platforms/connections, with NO structured action, must never resolve to
		// list_connections — it falls through inferOp to the default. Guards against
		// a future edit re-adding a broad routing regex.
		const runtime = mockRuntime([
			mockConnector("discord", "Discord", ["#general"]),
			mockConnector("matrix", "Matrix", ["Shape Rotator"]),
		]);
		let result: ActionResult | undefined;
		try {
			result = await messageAction.handler(
				runtime,
				{
					...message,
					content: {
						text: "what platforms am I connected to?",
						source: "discord",
					},
				} as Memory,
				undefined,
				{ parameters: {} }, // no explicit action — must NOT infer list_connections
				undefined,
				undefined,
			);
		} catch {
			// A non-list_connections op (e.g. the default "send") may fail in the
			// bare mock — fine; the point is it did NOT route to list_connections.
			result = undefined;
		}
		const data = result?.data as
			| { operation?: string; connectionCount?: number }
			| undefined;
		expect(data?.operation).not.toBe("list_connections");
		expect(data?.connectionCount).toBeUndefined();
	});
});

describe("MESSAGE trusted connector account routing", () => {
	it("passes the envelope account to a dispatcher and ignores Content spoofing", async () => {
		let routedAccountId: string | undefined;
		const runtime = mockRuntime([
			{
				source: "x",
				label: "X",
				accountRouting: "connector",
				capabilities: [],
				supportedTargetKinds: ["room"],
				contexts: [],
				listRooms: async (context: { accountId?: string }) => {
					routedAccountId = context.accountId;
					return [];
				},
			},
		]);
		const inbound = {
			...message,
			metadata: { type: "message", source: "x", accountId: "secondary" },
			content: {
				text: "show channels",
				source: "x",
				metadata: { accountId: "primary" },
			},
		} as Memory;

		const result = await messageAction.handler(
			runtime,
			inbound,
			undefined,
			{ parameters: { action: "list_channels", source: "x" } },
			undefined,
			undefined,
		);

		expect(result?.success).toBe(true);
		expect(routedAccountId).toBe("secondary");
		expect(inbound.content.metadata).toEqual({ accountId: "primary" });
	});

	it("fails closed when another account's display name collides with the trusted account id", async () => {
		const listRooms = async () => [];
		const runtime = mockRuntime([
			{
				source: "x",
				label: "X other account",
				accountId: "other",
				account: { accountId: "other", name: "original" },
				capabilities: [],
				supportedTargetKinds: ["room"],
				contexts: [],
				listRooms,
			},
		]);
		const inbound = {
			...message,
			metadata: { type: "message", source: "x", accountId: "original" },
			content: { text: "show channels", source: "x" },
		} as Memory;

		const result = await messageAction.handler(
			runtime,
			inbound,
			undefined,
			{ parameters: { action: "list_channels", source: "x" } },
			undefined,
			undefined,
		);

		expect(result?.success).toBe(false);
		expect(result?.data).toMatchObject({
			error: "ACCOUNT_CONNECTOR_NOT_FOUND",
		});
	});
});

describe("MESSAGE op=send owner-binding gate", () => {
	async function runtimeWithAccount(
		accessGate: "open" | "owner_binding",
		hasBinding: boolean,
	): Promise<{ runtime: IAgentRuntime; sent: { called: boolean } }> {
		const { ConnectorAccountManager, InMemoryConnectorAccountStorage } =
			await import("../../../connectors/account-manager.ts");
		// getStorage() returns the lazy-resolving facade since #18095, which
		// carries only the ConnectorAccountStorage contract — seed bindings on an
		// explicitly injected in-memory backend instead.
		const storage = new InMemoryConnectorAccountStorage();
		const manager = new ConnectorAccountManager(undefined, storage);
		manager.registerProvider({
			provider: "matrix",
			listAccounts: () => [
				{
					id: "personal",
					provider: "matrix",
					label: "@nubs:hs",
					role: accessGate === "owner_binding" ? "OWNER" : "AGENT",
					purpose: ["messaging"],
					accessGate,
					status: "connected",
					externalId: "hs/@nubs:hs",
					displayHandle: "@nubs:hs",
					createdAt: 1,
					updatedAt: 1,
				},
			],
		});
		if (hasBinding) {
			storage.upsertOwnerBindingForTest({
				id: "binding-1",
				identityId: "00000000-0000-0000-0000-0000000000cc",
				connector: "matrix",
				externalId: "hs/@nubs:hs",
				displayHandle: "@nubs:hs",
				instanceId: "",
				verifiedAt: 2,
			});
		}
		const sent = { called: false };
		const runtime = createMockRuntime({
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getService: (type: string) =>
				type === "connector_account" ? manager : null,
			getRoom: async () => null,
			getMessageConnectors: () => [
				{
					source: "matrix",
					label: "Matrix",
					accountId: "personal",
					capabilities: [],
					supportedTargetKinds: ["user"],
					contexts: [],
					listRecentTargets: async () => [
						{
							target: {
								source: "matrix",
								accountId: "personal",
								channelId: "!room",
							},
							label: "@nubs:hs",
							kind: "user" as const,
							score: 1,
							contexts: [],
						},
					],
				},
			],
			sendMessageToTarget: async () => {
				sent.called = true;
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			createMemory: async () => undefined,
			upsertMemory: async () => undefined,
			reportError: () => undefined,
		});
		return { runtime, sent };
	}

	const sendMessage = {
		...message,
		content: { text: "tell them hi", source: "matrix" },
	} as Memory;

	async function send(runtime: IAgentRuntime): Promise<ActionResult> {
		const result = await messageAction.handler(
			runtime,
			sendMessage,
			undefined,
			{
				parameters: {
					action: "send",
					message: "hi",
					persist: false,
					target: {
						source: "matrix",
						accountId: "personal",
						channelId: "!room",
					},
				},
			},
			undefined,
			undefined,
		);
		if (!result) throw new Error("no result");
		return result;
	}

	it("blocks a send through an unverified owner account", async () => {
		const { runtime, sent } = await runtimeWithAccount("owner_binding", false);
		const result = await send(runtime);
		expect(result.success).toBe(false);
		expect((result.data as { error?: string })?.error).toBe(
			"OWNER_BINDING_REQUIRED",
		);
		expect(sent.called).toBe(false);
	});

	it("allows a send through a verified owner account", async () => {
		const { runtime, sent } = await runtimeWithAccount("owner_binding", true);
		const result = await send(runtime);
		expect(result.success).toBe(true);
		expect(sent.called).toBe(true);
	});

	it("never gates a send through the agent's own (open) account", async () => {
		const { runtime, sent } = await runtimeWithAccount("open", false);
		const result = await send(runtime);
		expect(result.success).toBe(true);
		expect(sent.called).toBe(true);
	});
});

describe("MESSAGE op=send delivery evidence", () => {
	const recipient = "00000000-0000-0000-0000-0000000000dd";
	const receipt = (
		providerMessageIds: [string, ...string[]] = ["discord-message-123"],
	): SendHandlerReceipt => ({
		providerMessageIds,
		acceptedAt: 1_780_000_000_000,
		persistence: { status: "persisted", memoryIds: [] },
	});

	function runtimeForOutcome(outcome: Awaited<SendHandlerResult>): {
		runtime: IAgentRuntime;
		upsertMemory: ReturnType<typeof vi.fn>;
		createMemory: ReturnType<typeof vi.fn>;
		setOutboundPersistenceFailure: (error: Error) => void;
	} {
		let outboundPersistenceFailure: Error | undefined;
		const upsertMemory = vi.fn(async () => {
			if (outboundPersistenceFailure) {
				throw outboundPersistenceFailure;
			}
		});
		const createMemory = vi.fn(async () => undefined);
		const runtime = createMockRuntime({
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getEntityById: async () => null,
			useModel: async () => {
				throw new Error(
					"explicit UUID targets must not invoke model resolution",
				);
			},
			getMessageConnectors: () => [
				{
					source: "discord",
					label: "Discord",
					capabilities: [],
					supportedTargetKinds: ["user"],
					contexts: [],
				},
			],
			getRoom: async () => null,
			sendMessageToTarget: async () => outcome,
			ensureWorldExists: async () => undefined,
			ensureRoomExists: async () => undefined,
			ensureParticipantInRoom: async () => undefined,
			upsertMemory,
			createMemory,
		});
		return {
			runtime,
			upsertMemory,
			createMemory,
			setOutboundPersistenceFailure: (error) => {
				outboundPersistenceFailure = error;
			},
		};
	}

	async function sendWithOutcome(
		outcome: Awaited<SendHandlerResult>,
		options?: { outboundPersistenceFailure?: Error },
	): Promise<{
		result: ActionResult;
		upsertMemory: ReturnType<typeof vi.fn>;
		createMemory: ReturnType<typeof vi.fn>;
	}> {
		const {
			runtime,
			upsertMemory,
			createMemory,
			setOutboundPersistenceFailure,
		} = runtimeForOutcome(outcome);
		if (options?.outboundPersistenceFailure) {
			setOutboundPersistenceFailure(options.outboundPersistenceFailure);
		}
		const result = await messageAction.handler(
			runtime,
			{
				...message,
				content: { text: "send a status update", source: "discord" },
			} as Memory,
			undefined,
			{
				parameters: {
					action: "send",
					source: "discord",
					target: recipient,
					targetKind: "user",
					message: "status update",
				},
			},
			undefined,
			undefined,
		);
		if (!result) throw new Error("no result");
		return { result, upsertMemory, createMemory };
	}

	const unconfirmedCases: Array<{
		name: string;
		outcome: SendHandlerOutcome | undefined;
		error: string;
		text: RegExp;
	}> = [
		{
			name: "duplicate still in flight",
			outcome: { kind: "duplicate", priorDelivery: "in_flight" },
			error: "MESSAGE_DELIVERY_IN_FLIGHT",
			text: /not yet confirmed/i,
		},
		{
			name: "explicit connector refusal",
			outcome: {
				kind: "not_delivered",
				code: "CHANNEL_NOT_ALLOWED",
				message: "Target channel is not allowed.",
			},
			error: "MESSAGE_NOT_DELIVERED",
			text: /was not delivered/i,
		},
		{
			name: "legacy connector ambiguity",
			outcome: undefined,
			error: "MESSAGE_DELIVERY_UNKNOWN",
			text: /returned no delivery receipt/i,
		},
	];

	for (const testCase of unconfirmedCases) {
		it(`does not persist or narrate success for ${testCase.name}`, async () => {
			const { result, upsertMemory, createMemory } = await sendWithOutcome(
				testCase.outcome,
			);
			expect(result.success).toBe(false);
			expect(result.data).toMatchObject({ error: testCase.error });
			expect(result.text).toMatch(testCase.text);
			expect(result.text).not.toContain("Message sent via");
			expect(upsertMemory).not.toHaveBeenCalled();
			expect(createMemory).not.toHaveBeenCalled();
		});
	}

	it("reports a committed duplicate only with the replayed provider receipt", async () => {
		const { result, upsertMemory, createMemory } = await sendWithOutcome({
			kind: "duplicate",
			priorDelivery: "delivered",
			receipt: receipt(),
		});
		expect(result).toMatchObject({
			success: true,
			data: {
				deliveryStatus: "duplicate",
				priorDelivery: "delivered",
				responseMessageId: "discord-message-123",
				newDelivery: false,
				persisted: false,
			},
		});
		expect(result.text).toContain("had already been delivered");
		expect(result.text).not.toContain("Message sent via");
		expect(upsertMemory).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("exposes a provider-accepted prefix without claiming complete delivery", async () => {
		const { result, upsertMemory, createMemory } = await sendWithOutcome({
			kind: "partially_delivered",
			receipt: receipt(["discord-chunk-1"]),
			memories: [],
			code: "DISCORD_PROVIDER_PARTIAL_DELIVERY",
			message: "The second chunk failed.",
		});
		expect(result).toMatchObject({
			success: false,
			data: {
				error: "MESSAGE_PARTIAL_DELIVERY",
				acceptance: "partial",
				responseMessageId: "discord-chunk-1",
				providerMessageIds: ["discord-chunk-1"],
				newDelivery: true,
			},
		});
		expect(result.text).toMatch(/do not retry blindly/i);
		expect(upsertMemory).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("reports provider acceptance when local persistence failed without resending", async () => {
		const failedReceipt: SendHandlerReceipt = {
			providerMessageIds: ["discord-message-accepted"],
			acceptedAt: 1_780_000_000_000,
			persistence: {
				status: "failed",
				failures: [
					{
						providerMessageId: "discord-message-accepted",
						stage: "memory",
						code: "PERSISTENCE_FAILED",
						message: "database unavailable",
					},
				],
			},
		};
		const { result, upsertMemory, createMemory } = await sendWithOutcome({
			kind: "delivered",
			receipt: failedReceipt,
			memories: [],
		});
		expect(result).toMatchObject({
			success: false,
			data: {
				error: "MESSAGE_DELIVERED_PERSISTENCE_FAILED",
				acceptance: "accepted",
				responseMessageId: "discord-message-accepted",
				persistenceStatus: "failed",
				newDelivery: true,
			},
		});
		expect(result.text).toMatch(/do not resend/i);
		expect(upsertMemory).not.toHaveBeenCalled();
		expect(createMemory).not.toHaveBeenCalled();
	});

	it("does not narrate success when its requested local write fails after acceptance", async () => {
		const { result, upsertMemory } = await sendWithOutcome(
			{
				kind: "delivered",
				receipt: receipt(["discord-message-accepted"]),
				memories: [],
			},
			{ outboundPersistenceFailure: new Error("database unavailable") },
		);
		expect(result).toMatchObject({
			success: false,
			data: {
				error: "MESSAGE_DELIVERED_PERSISTENCE_FAILED",
				acceptance: "accepted",
				responseMessageId: "discord-message-accepted",
				providerMessageIds: ["discord-message-accepted"],
				persistenceStatus: "failed",
				persistenceCode: "MESSAGE_OUTBOUND_MEMORY_PERSISTENCE_FAILED",
				newDelivery: true,
				persisted: false,
			},
		});
		expect(result.text).toMatch(/do not resend/i);
		expect(result.text).not.toContain("Message sent via");
		expect(upsertMemory).toHaveBeenCalledTimes(1);
	});
});

describe("inferOp is i18n-safe (#10471)", () => {
	it("routes by the planner-emitted action enum (+ aliases)", () => {
		expect(inferOp({ action: "delete" })).toBe("delete");
		expect(inferOp({ action: "triage" })).toBe("triage");
		expect(inferOp({ action: "list_connections" })).toBe("list_connections");
	});

	it("honors structured params without text inference", () => {
		expect(inferOp({ draftId: "d1", sendAt: "2026-01-01T00:00:00Z" })).toBe(
			"schedule_draft_send",
		);
		expect(inferOp({ draftId: "d1" })).toBe("send_draft");
		expect(inferOp({ manageOperation: "archive" })).toBe("manage");
		expect(inferOp({ query: "vitalik" })).toBe("search");
		expect(inferOp({ emoji: "❤️" })).toBe("react");
	});

	it("does NOT infer the op from natural-language text in any language", () => {
		// Routing never infers the op from natural-language message text (any
		// language): with no structured signal the op defaults to the safe `send`,
		// and the real op comes from the planner's `action` enum, which it emits in
		// any language.
		expect(inferOp({})).toBe("send");
		// A `text`-like field is not a recognized structured param and must be
		// ignored by routing.
		expect(inferOp({ text: "delete that message" })).toBe("send");
		expect(inferOp({ text: "そのメッセージを削除して" })).toBe("send");
	});
});

describe("MESSAGE op=send room-first name resolution (over-routing fix)", () => {
	const ROOM_ID = "00000000-0000-0000-0000-0000000000bb";
	const SHADOW_ID = "00000000-0000-0000-0000-0000000000e1";
	const OTHER_ID = "00000000-0000-0000-0000-0000000000e2";

	function roomFixture() {
		return {
			id: ROOM_ID,
			name: "#general",
			source: "discord",
			channelId: "chan-1",
			serverId: "guild-1",
		};
	}

	function harness(options: {
		roomEntities: Array<{
			id: string;
			names: string[];
			components?: Array<{ data?: Record<string, unknown> }>;
		}>;
		hookCandidates?: Array<Record<string, unknown>>;
		getEntityById?: (id: string) => Promise<unknown>;
		getRelationships?: () => Promise<unknown[]>;
	}) {
		const sends: Array<{ target: Record<string, unknown>; text: string }> = [];
		const resolveTargets = vi.fn(async () => options.hookCandidates ?? []);
		const cache = new Map<string, unknown>();
		const runtime = createMockRuntime({
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getMessageConnectors: () => [
				{
					source: "discord",
					label: "Discord",
					capabilities: [],
					supportedTargetKinds: ["user", "room", "channel"],
					contexts: [],
					resolveTargets,
				},
			],
			getRoom: async () => roomFixture(),
			getEntitiesForRoom: async () => options.roomEntities,
			getEntityById: (options.getEntityById ??
				(async () => null)) as IAgentRuntime["getEntityById"],
			getRelationships: (options.getRelationships ??
				(async () => [])) as IAgentRuntime["getRelationships"],
			getCache: (async (key: string) =>
				cache.get(key)) as IAgentRuntime["getCache"],
			setCache: (async (key: string, value: unknown) => {
				cache.set(key, value);
				return true;
			}) as IAgentRuntime["setCache"],
			deleteCache: (async (key: string) =>
				cache.delete(key)) as IAgentRuntime["deleteCache"],
			sendMessageToTarget: async (target, content) => {
				sends.push({
					target: target as unknown as Record<string, unknown>,
					text: String(content.text ?? ""),
				});
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			useModel: async () => {
				throw new Error(
					"room-first resolution must be deterministic — no model call",
				);
			},
			reportError: () => undefined,
		});
		return { runtime, sends, resolveTargets };
	}

	async function send(
		runtime: IAgentRuntime,
		params: Record<string, unknown>,
		text = "tell vega to take a break",
	): Promise<ActionResult> {
		const result = await messageAction.handler(
			runtime,
			{
				...message,
				content: { text, source: "discord" },
			} as Memory,
			undefined,
			{ parameters: { action: "send", persist: false, ...params } },
			undefined,
			undefined,
		);
		if (!result) throw new Error("no result");
		return result;
	}

	it("a name matching a room participant resolves to an in-channel utterance, not a DM or contact lookup", async () => {
		const { runtime, sends, resolveTargets } = harness({
			roomEntities: [
				{ id: SHADOW_ID, names: ["Vega"] },
				{ id: OTHER_ID, names: ["Someone Else"] },
			],
			// A guild-wide fuzzy stranger match must never be consulted first.
			hookCandidates: [
				{
					target: { source: "discord", entityId: "555000111" },
					label: "@vegafox",
					kind: "user",
					score: 0.95,
					contexts: [],
				},
			],
		});
		const result = await send(runtime, {
			target: "vega",
			message: "take a break",
		});

		expect(result.success).toBe(true);
		expect(sends).toHaveLength(1);
		// Delivered IN the originating channel — never as an entity DM.
		expect(sends[0].target).toMatchObject({
			source: "discord",
			roomId: ROOM_ID,
			channelId: "chan-1",
		});
		expect(sends[0].target.entityId).toBeUndefined();
		// The in-channel utterance addresses the member.
		expect(sends[0].text).toBe("@Vega take a break");
		// Room-first short-circuits the connector-wide fuzzy lookup entirely.
		expect(resolveTargets).not.toHaveBeenCalled();
	});

	it("does not double-address when the text already names the member", async () => {
		const { runtime, sends } = harness({
			roomEntities: [{ id: SHADOW_ID, names: ["Vega"] }],
		});
		const result = await send(runtime, {
			target: "vega",
			message: "vega, please take a break",
		});
		expect(result.success).toBe(true);
		expect(sends[0].text).toBe("vega, please take a break");
	});

	it("matches through connector component names (username/displayName)", async () => {
		const { runtime, sends } = harness({
			roomEntities: [
				{
					id: SHADOW_ID,
					names: ["Casts No Light"],
					components: [{ data: { username: "vega" } }],
				},
			],
		});
		const result = await send(runtime, {
			target: "@vega",
			message: "take a break",
		});
		expect(result.success).toBe(true);
		expect(sends[0].target).toMatchObject({ roomId: ROOM_ID });
	});

	it("two matching room participants stay ambiguous — asks instead of guessing", async () => {
		const { runtime, sends } = harness({
			roomEntities: [
				{ id: SHADOW_ID, names: ["Vega"] },
				{
					id: OTHER_ID,
					names: ["Vega Two"],
					components: [{ data: { username: "vega" } }],
				},
			],
		});
		const result = await send(runtime, {
			target: "vega",
			message: "take a break",
		});

		expect(result.success).toBe(false);
		expect((result.data as { error?: string })?.error).toBe("TARGET_AMBIGUOUS");
		expect(
			(result.data as { candidates?: unknown[] })?.candidates,
		).toHaveLength(2);
		expect(sends).toHaveLength(0);
	});
});

describe("MESSAGE op=send unvetted-recipient confirmation gate (stranger-DM close)", () => {
	const STRANGER_PLATFORM_ID = "555000111";
	const KNOWN_PLATFORM_ID = "555000222";
	const REQUESTER_ENTITY_ID = "00000000-0000-0000-0000-0000000000cc";
	const THIRD_PARTY_ENTITY_ID = "00000000-0000-0000-0000-00000000decaf";

	function harness(options: {
		known: boolean;
		roomEntities?: Array<{ id: string; names: string[] }>;
		relationship?: "forward" | "reverse" | "unrelated" | "none";
	}) {
		const sends: Array<{ target: Record<string, unknown> }> = [];
		const cache = new Map<string, unknown>();
		const relationshipQueries: Array<{
			sourceEntityId: string;
			targetEntityId: string;
		}> = [];
		const platformId = options.known ? KNOWN_PLATFORM_ID : STRANGER_PLATFORM_ID;
		const runtime = createMockRuntime({
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getMessageConnectors: () => [
				{
					source: "discord",
					label: "Discord",
					capabilities: [],
					supportedTargetKinds: ["user"],
					contexts: [],
					resolveTargets: async () => [
						{
							target: { source: "discord", entityId: platformId },
							label: "@fuzzymatch",
							kind: "user" as const,
							score: 0.95,
							contexts: [],
						},
					],
				},
			],
			getRoom: async () => null,
			getEntitiesForRoom: async () => options.roomEntities ?? [],
			getEntityById: (async (id: string) =>
				options.known
					? { id, names: ["Known Friend"] }
					: null) as IAgentRuntime["getEntityById"],
			getRelationships: async () => {
				throw new Error(
					"recipient gate must not use a broad relationship query",
				);
			},
			getRelationshipsByPairs: (async (pairs) => {
				relationshipQueries.push(...pairs);
				const recipientId = pairs.find(
					(pair) => pair.sourceEntityId === REQUESTER_ENTITY_ID,
				)?.targetEntityId;
				const relationship =
					options.relationship ?? (options.known ? "forward" : "none");
				const storedEdge =
					relationship === "forward" && recipientId
						? {
								sourceEntityId: REQUESTER_ENTITY_ID,
								targetEntityId: recipientId,
							}
						: relationship === "reverse" && recipientId
							? {
									sourceEntityId: recipientId,
									targetEntityId: REQUESTER_ENTITY_ID,
								}
							: relationship === "unrelated" && recipientId
								? {
										sourceEntityId: recipientId,
										targetEntityId: THIRD_PARTY_ENTITY_ID,
									}
								: null;
				return pairs.map((pair) =>
					storedEdge &&
					storedEdge.sourceEntityId === pair.sourceEntityId &&
					storedEdge.targetEntityId === pair.targetEntityId
						? storedEdge
						: null,
				);
			}) as IAgentRuntime["getRelationshipsByPairs"],
			getCache: (async (key: string) =>
				cache.get(key)) as IAgentRuntime["getCache"],
			setCache: (async (key: string, value: unknown) => {
				cache.set(key, value);
				return true;
			}) as IAgentRuntime["setCache"],
			deleteCache: (async (key: string) =>
				cache.delete(key)) as IAgentRuntime["deleteCache"],
			sendMessageToTarget: async (target) => {
				sends.push({ target: target as unknown as Record<string, unknown> });
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			useModel: async () => {
				throw new Error("gate must be deterministic — no model call");
			},
			reportError: () => undefined,
		});
		return { relationshipQueries, runtime, sends };
	}

	async function send(
		runtime: IAgentRuntime,
		text: string,
	): Promise<ActionResult> {
		const result = await messageAction.handler(
			runtime,
			{ ...message, content: { text, source: "discord" } } as Memory,
			undefined,
			{
				parameters: {
					action: "send",
					persist: false,
					target: "fuzzymatch",
					targetKind: "user",
					message: "hey there",
				},
			},
			undefined,
			undefined,
		);
		if (!result) throw new Error("no result");
		return result;
	}

	it("a fuzzy connector match to a STRANGER is confirm-gated — nothing is sent", async () => {
		const { runtime, sends } = harness({ known: false });
		const result = await send(runtime, "message fuzzymatch saying hey");

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			confirmationRequired: true,
			awaitingUserInput: true,
		});
		expect(sends).toHaveLength(0);
	});

	it("after the user confirms, the send proceeds", async () => {
		const { runtime, sends } = harness({ known: false });
		const first = await send(runtime, "message fuzzymatch saying hey");
		expect(first.data).toMatchObject({ awaitingUserInput: true });
		expect(sends).toHaveLength(0);

		const second = await send(runtime, "yes");
		expect(second.success).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({ entityId: STRANGER_PLATFORM_ID });
	});

	it("a declined confirmation cancels the send", async () => {
		const { runtime, sends } = harness({ known: false });
		await send(runtime, "message fuzzymatch saying hey");
		const second = await send(runtime, "no, don't do that");

		expect(second.success).toBe(false);
		expect(second.data).toMatchObject({ cancelled: true });
		expect(sends).toHaveLength(0);
	});

	it("a relationship-backed recipient still DMs directly (saved-contact path unchanged)", async () => {
		const { runtime, sends } = harness({ known: true });
		const result = await send(runtime, "message my friend saying hey");

		expect(result.success).toBe(true);
		expect(result.data).not.toMatchObject({ confirmationRequired: true });
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({ entityId: KNOWN_PLATFORM_ID });
	});

	it("an unrelated third-party relationship does NOT bypass confirmation (#18107)", async () => {
		const { relationshipQueries, runtime, sends } = harness({
			known: true,
			relationship: "unrelated",
		});
		const result = await send(runtime, "message fuzzymatch saying hey");

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			confirmationRequired: true,
			awaitingUserInput: true,
		});
		expect(sends).toHaveLength(0);
		const recipientId = relationshipQueries[0]?.targetEntityId;
		if (!recipientId)
			throw new Error("exact relationship pair was not queried");
		expect(relationshipQueries).toEqual([
			{
				sourceEntityId: REQUESTER_ENTITY_ID,
				targetEntityId: recipientId,
			},
			{
				sourceEntityId: recipientId,
				targetEntityId: REQUESTER_ENTITY_ID,
			},
		]);
	});

	it("a reciprocal relationship (target→requester) still DMs directly (#18107)", async () => {
		const { runtime, sends } = harness({
			known: true,
			relationship: "reverse",
		});
		const result = await send(runtime, "message fuzzymatch saying hey");

		expect(result.success).toBe(true);
		expect(result.data).not.toMatchObject({ confirmationRequired: true });
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({ entityId: KNOWN_PLATFORM_ID });
	});
});
