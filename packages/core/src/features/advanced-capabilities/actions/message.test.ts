/**
 * Covers the MESSAGE action: the list_connections cross-connector roster, the
 * op=send owner-binding gate, and i18n-safe op inference (#10471). Uses
 * createMockRuntime with deterministic mock connectors — no live model, no DB.
 */

import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
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

	it("a failing connector still appears with roomCount 0", async () => {
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
		]);
		const result = await listConnections(runtime);
		const data = result.data as {
			connections: { platform: string; roomCount: number }[];
		};
		const x = data.connections.find((c) => c.platform === "x");
		expect(x).toBeDefined();
		expect(x?.roomCount).toBe(0);
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

describe("MESSAGE op=send owner-binding gate", () => {
	async function runtimeWithAccount(
		accessGate: "open" | "owner_binding",
		hasBinding: boolean,
	): Promise<{ runtime: IAgentRuntime; sent: { called: boolean } }> {
		const { ConnectorAccountManager } = await import(
			"../../../connectors/account-manager.ts"
		);
		const manager = new ConnectorAccountManager();
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
			(
				manager.getStorage() as {
					upsertOwnerBindingForTest(b: unknown): void;
				}
			).upsertOwnerBindingForTest({
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
