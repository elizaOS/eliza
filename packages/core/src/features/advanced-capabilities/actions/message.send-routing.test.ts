/**
 * Covers MESSAGE op=send smart routing: the exact-beats-prefix confidence
 * tier, the unresolved-recipient upfront clarify, the last-delivered-channel
 * preference (write + read), and the admin/owner shortcut over the current /
 * internal transport. Deterministic mock runtime and connectors — no live
 * model, no DB.
 */

import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime";
import type {
	ActionResult,
	Component,
	IAgentRuntime,
	Memory,
} from "../../../types/index.ts";
import { messageAction } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-0000000000bb";
const SENDER_ID = "00000000-0000-0000-0000-0000000000cc";
const SHADOW_ID = "00000000-0000-0000-0000-0000000000e7";

const baseMessage = {
	id: "00000000-0000-0000-0000-0000000000aa",
	roomId: ROOM_ID,
	entityId: SENDER_ID,
	agentId: AGENT_ID,
	content: { text: "tell shadow to stop smoking", source: "discord" },
	createdAt: 1,
} as unknown as Memory;

type SentMessage = {
	target: Record<string, unknown>;
	text: string;
	metadata?: Record<string, unknown>;
};

async function send(
	runtime: IAgentRuntime,
	params: Record<string, unknown>,
	message: Memory = baseMessage,
): Promise<ActionResult> {
	const result = await messageAction.handler(
		runtime,
		message,
		undefined,
		{ parameters: { action: "send", persist: false, ...params } },
		undefined,
		undefined,
	);
	if (!result) throw new Error("handler returned no result");
	return result;
}

describe("MESSAGE op=send exact-beats-prefix tier (ambiguity over-fire fix)", () => {
	function harness(hookCandidates: Array<Record<string, unknown>>) {
		const sends: SentMessage[] = [];
		const resolveTargets = vi.fn(async () => hookCandidates);
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
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
			getRoom: async () => null,
			getEntitiesForRoom: async () => [],
			getEntityById: (async () => null) as IAgentRuntime["getEntityById"],
			getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
			sendMessageToTarget: async (target, content) => {
				sends.push({
					target: target as unknown as Record<string, unknown>,
					text: String(content.text ?? ""),
				});
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			useModel: async () => {
				throw new Error("resolution must be deterministic — no model call");
			},
			reportError: () => undefined,
		});
		return { runtime, sends, resolveTargets };
	}

	it("an exact label match beats a prefix match instead of tripping the ambiguity brake", async () => {
		const { runtime, sends } = harness([
			{
				target: { source: "discord", channelId: "dm-shadow", entityId: "111" },
				label: "shadow",
				kind: "user",
				score: 0.95,
				contexts: [],
			},
			{
				target: {
					source: "discord",
					channelId: "dm-shadowfax",
					entityId: "222",
				},
				label: "shadowfax",
				kind: "user",
				score: 0.85,
				contexts: [],
			},
		]);
		const result = await send(runtime, {
			target: "shadow",
			targetKind: "user",
			message: "stop smoking",
		});

		expect(result.success).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({ channelId: "dm-shadow" });
	});

	it("two exact matches remain genuinely ambiguous — asks instead of guessing", async () => {
		const { runtime, sends } = harness([
			{
				target: {
					source: "discord",
					channelId: "dm-shadow-1",
					entityId: "111",
				},
				label: "shadow",
				kind: "user",
				score: 0.95,
				contexts: [],
			},
			{
				target: {
					source: "discord",
					channelId: "dm-shadow-2",
					entityId: "222",
				},
				label: "shadow",
				kind: "user",
				score: 0.95,
				contexts: [],
			},
		]);
		const result = await send(runtime, {
			target: "shadow",
			targetKind: "user",
			message: "stop smoking",
		});

		expect(result.success).toBe(false);
		expect((result.data as { error?: string })?.error).toBe("TARGET_AMBIGUOUS");
		expect(sends).toHaveLength(0);
	});
});

describe("MESSAGE op=send unresolved recipient asks upfront (no doomed send)", () => {
	function harness() {
		const sends: SentMessage[] = [];
		const cache = new Map<string, unknown>();
		const runtime = createMockRuntime({
			getCache: (async (key: string) =>
				cache.get(key)) as IAgentRuntime["getCache"],
			setCache: (async (key: string, value: unknown) => {
				cache.set(key, value);
				return true;
			}) as IAgentRuntime["setCache"],
			deleteCache: (async (key: string) =>
				cache.delete(key)) as IAgentRuntime["deleteCache"],
			agentId: AGENT_ID,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getMessageConnectors: () => [
				{
					source: "discord",
					label: "Discord",
					capabilities: [],
					supportedTargetKinds: ["user", "room", "channel", "email"],
					contexts: [],
					resolveTargets: async () => [],
				},
			],
			getRoom: async () => null,
			getEntitiesForRoom: async () => [],
			getEntityById: (async () => null) as IAgentRuntime["getEntityById"],
			getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
			sendMessageToTarget: async (target, content) => {
				sends.push({
					target: target as unknown as Record<string, unknown>,
					text: String(content.text ?? ""),
					metadata: content.metadata as Record<string, unknown>,
				});
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			useModel: async () => {
				throw new Error("resolution must be deterministic — no model call");
			},
			reportError: () => undefined,
		});
		return { runtime, sends };
	}

	it("an unresolvable bare name fails fast with a clarify, not a shipped send", async () => {
		const { runtime, sends } = harness();
		const result = await send(runtime, {
			target: "shadow",
			message: "stop smoking",
		});

		expect(result.success).toBe(false);
		expect((result.data as { error?: string })?.error).toBe(
			"TARGET_UNRESOLVED_RECIPIENT",
		);
		expect(result.text).toContain('"shadow"');
		expect(result.data).not.toMatchObject({ confirmationRequired: true });
		expect(sends).toHaveLength(0);
	});

	it("a literal email address is address-routed and delivers without a contact lookup", async () => {
		const { runtime, sends } = harness();
		const result = await send(runtime, {
			target: "shadow@example.com",
			message: "stop smoking",
			subject: "A friendly reminder",
		});

		expect(result.success).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({
			channelId: "shadow@example.com",
		});
		expect(sends[0].metadata).toMatchObject({
			subject: "A friendly reminder",
		});
	});

	it("a numeric platform id stays on the explicit path (not treated as an unknown name)", async () => {
		const { runtime } = harness();
		const result = await send(runtime, {
			target: "555000111222333",
			targetKind: "user",
			message: "hey",
		});

		// The raw platform id proceeds to the recipient gate (confirmation),
		// never the unresolved-name clarify.
		expect((result.data as { error?: string })?.error).not.toBe(
			"TARGET_UNRESOLVED_RECIPIENT",
		);
	});
});

describe("MESSAGE op=send last-delivered-channel preference", () => {
	function shadowEntity(withPreference: boolean) {
		const components: Array<{
			id: string;
			type: string;
			sourceEntityId: string;
			data: Record<string, unknown>;
		}> = [
			{
				id: "00000000-0000-0000-0000-0000000000c1",
				type: "discord",
				sourceEntityId: AGENT_ID,
				data: { channelId: "dm-discord" },
			},
			{
				id: "00000000-0000-0000-0000-0000000000c2",
				type: "telegram",
				sourceEntityId: AGENT_ID,
				data: { channelId: "dm-telegram" },
			},
		];
		if (withPreference) {
			components.push({
				id: "00000000-0000-0000-0000-0000000000c3",
				type: "message_delivery_preference",
				sourceEntityId: AGENT_ID,
				data: { source: "telegram" },
			});
		}
		return {
			id: SHADOW_ID,
			names: ["Shadow"],
			agentId: AGENT_ID,
			components,
		};
	}

	function harness(options: { withPreference: boolean }) {
		const sends: SentMessage[] = [];
		const upserts: Component[] = [];
		const entity = shadowEntity(options.withPreference);
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getMessageConnectors: () => [
				{
					source: "discord",
					label: "Discord",
					capabilities: [],
					supportedTargetKinds: ["user", "contact"],
					contexts: [],
				},
				{
					source: "telegram",
					label: "Telegram",
					capabilities: [],
					supportedTargetKinds: ["user", "contact"],
					contexts: [],
				},
			],
			// The room's source has no registered connector, so the room-first
			// member path stays out of the way and the entity path is exercised.
			getRoom: async () => ({ id: ROOM_ID, name: "app", source: "app" }),
			getEntitiesForRoom: async () => [entity],
			getWorld: (async () => null) as IAgentRuntime["getWorld"],
			getEntityById: (async (id: string) =>
				id === SHADOW_ID ? entity : null) as IAgentRuntime["getEntityById"],
			getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
			getMemories: (async () => []) as IAgentRuntime["getMemories"],
			sendMessageToTarget: async (target, content) => {
				sends.push({
					target: target as unknown as Record<string, unknown>,
					text: String(content.text ?? ""),
				});
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			upsertComponent: (async (component: Component) => {
				upserts.push(component);
			}) as IAgentRuntime["upsertComponent"],
			// findEntityByName degrades to its sole-candidate heuristic on
			// unparseable model output — resolution stays deterministic.
			useModel: (async () => "not-json") as IAgentRuntime["useModel"],
			reportError: () => undefined,
		});
		return { runtime, sends, upserts };
	}

	it("without a recorded preference, two stored handles stay ambiguous (baseline)", async () => {
		const { runtime, sends } = harness({ withPreference: false });
		const message = {
			...baseMessage,
			content: { text: "tell shadow to stop smoking", source: "app" },
		} as Memory;
		const result = await send(
			runtime,
			{ target: "shadow", message: "stop smoking" },
			message,
		);

		expect(result.success).toBe(false);
		expect((result.data as { error?: string })?.error).toBe("TARGET_AMBIGUOUS");
		expect(sends).toHaveLength(0);
	});

	it("prefers the channel the person was last reached on", async () => {
		const { runtime, sends } = harness({ withPreference: true });
		const message = {
			...baseMessage,
			content: { text: "tell shadow to stop smoking", source: "app" },
		} as Memory;
		const result = await send(
			runtime,
			{ target: "shadow", message: "stop smoking" },
			message,
		);

		expect(result.success).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({
			source: "telegram",
			channelId: "dm-telegram",
		});
		expect(
			(result.data as { resolutionReasons?: string[] })?.resolutionReasons,
		).toContain("lastChannel");
	});

	it("a successful entity delivery records the channel for next time", async () => {
		const { runtime, upserts } = harness({ withPreference: true });
		const message = {
			...baseMessage,
			content: { text: "tell shadow to stop smoking", source: "app" },
		} as Memory;
		const result = await send(
			runtime,
			{ target: "shadow", message: "stop smoking" },
			message,
		);

		expect(result.success).toBe(true);
		expect(upserts).toHaveLength(1);
		expect(upserts[0]).toMatchObject({
			entityId: SHADOW_ID,
			type: "message_delivery_preference",
			data: { source: "telegram" },
		});
	});
});

describe("MESSAGE op=send admin/owner target (app + connector transports)", () => {
	it("resolves 'owner' through the internal client_chat transport when no connector is registered", async () => {
		const sends: SentMessage[] = [];
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getMessageConnectors: () => [],
			getRoom: async () => null,
			getSetting: (() => undefined) as IAgentRuntime["getSetting"],
			sendMessageToTarget: async (target, content) => {
				sends.push({
					target: target as unknown as Record<string, unknown>,
					text: String(content.text ?? ""),
				});
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			useModel: async () => {
				throw new Error("admin resolution must be deterministic");
			},
			reportError: () => undefined,
		});
		(
			runtime as unknown as { sendHandlers: Map<string, unknown> }
		).sendHandlers = new Map([["client_chat", async () => undefined]]);

		const message = {
			...baseMessage,
			content: {
				text: "message the owner that I'm done",
				source: "client_chat",
			},
		} as Memory;
		const result = await send(
			runtime,
			{ target: "owner", message: "the report is done" },
			message,
		);

		expect(result.success).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({
			source: "client_chat",
			roomId: ROOM_ID,
		});
	});

	it("resolves 'admin' over the current conversation's connector, never a fuzzy user match", async () => {
		const sends: SentMessage[] = [];
		const resolveTargets = vi.fn(async () => [
			{
				target: { source: "discord", entityId: "999" },
				label: "@adminlarper",
				kind: "user" as const,
				score: 0.95,
				contexts: [],
			},
		]);
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
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
			getRoom: async () => null,
			getSetting: (() => undefined) as IAgentRuntime["getSetting"],
			sendMessageToTarget: async (target, content) => {
				sends.push({
					target: target as unknown as Record<string, unknown>,
					text: String(content.text ?? ""),
				});
				return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
			},
			useModel: async () => {
				throw new Error("admin resolution must be deterministic");
			},
			reportError: () => undefined,
		});

		const result = await send(runtime, {
			target: "admin",
			message: "task finished",
		});

		expect(result.success).toBe(true);
		expect(sends).toHaveLength(1);
		expect(sends[0].target).toMatchObject({ source: "discord" });
		expect(sends[0].target.entityId).toBeDefined();
		expect(resolveTargets).not.toHaveBeenCalled();
	});
});
