import type {
	Content,
	IAgentRuntime,
	Memory,
	MessageConnectorQueryContext,
	MessageConnectorTarget,
	TargetInfo,
	UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { DiscordTriageAdapter, mapDiscordMemoryToRef } from "../triage-adapter";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000b001" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c001" as UUID;

function hashCode(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 31 + value.charCodeAt(i)) | 0;
	}
	return hash;
}

function discordMemory(overrides: {
	messageId: string;
	channelId: string;
	serverId?: string;
	text?: string;
	entityId?: UUID;
	createdAt?: number;
	fromBot?: boolean;
	attachments?: unknown[];
}): Memory {
	return {
		id: `00000000-0000-0000-0000-${String(
			Math.abs(hashCode(overrides.messageId)),
		).padStart(12, "0")}` as UUID,
		entityId: overrides.entityId ?? USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: {
			text: overrides.text ?? "hello there",
			source: "discord",
			url: `https://discord.com/channels/x/${overrides.channelId}/${overrides.messageId}`,
			attachments: overrides.attachments as Memory["content"]["attachments"],
		},
		metadata: {
			type: "message",
			source: "discord",
			accountId: "default",
			entityName: "nubs",
			entityUserName: "nubscarson",
			fromBot: overrides.fromBot ?? false,
			fromId: "111222333444555666",
			discordMessageId: overrides.messageId,
			discordChannelId: overrides.channelId,
			discordServerId: overrides.serverId ?? "999888777666555444",
		} as Memory["metadata"],
		createdAt: overrides.createdAt ?? Date.now(),
	};
}

interface FakeServiceOptions {
	channels?: Array<{ channelId: string; serverId?: string }>;
	messagesByChannel?: Record<string, Memory[]>;
	failChannels?: Set<string>;
	sentMemory?: Memory;
}

function createFakeDiscordService(opts: FakeServiceOptions = {}) {
	const sends: Array<{ target: TargetInfo; content: Content }> = [];
	const service = {
		sends,
		async fetchConnectorMessages(
			_context: MessageConnectorQueryContext,
			params: { channelId?: string; limit?: number },
		): Promise<Memory[]> {
			const channelId = params.channelId ?? "";
			if (opts.failChannels?.has(channelId)) {
				throw new Error(`Missing Access on channel ${channelId}`);
			}
			return opts.messagesByChannel?.[channelId] ?? [];
		},
		async listConnectorRooms(
			_context: MessageConnectorQueryContext,
		): Promise<MessageConnectorTarget[]> {
			return (opts.channels ?? []).map(({ channelId, serverId }) => ({
				target: { source: "discord", channelId, serverId },
			}));
		},
		async handleSendMessage(
			_runtime: IAgentRuntime,
			target: TargetInfo,
			content: Content,
		): Promise<Memory | undefined> {
			sends.push({ target, content });
			return opts.sentMemory;
		},
	};
	return service;
}

function createRuntime(service: unknown): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getService: (name: string) => (name === "discord" ? service : null),
	} as IAgentRuntime;
}

describe("mapDiscordMemoryToRef", () => {
	it("maps connector Memory to the cross-connector MessageRef shape", () => {
		const memory = discordMemory({
			messageId: "123",
			channelId: "555",
			serverId: "777",
			text: "gm cozy devs",
			createdAt: 1_700_000_000_000,
		});
		const ref = mapDiscordMemoryToRef(memory);
		expect(ref).not.toBeNull();
		expect(ref?.id).toBe("discord:123");
		expect(ref?.externalId).toBe("123");
		expect(ref?.source).toBe("discord");
		expect(ref?.from.identifier).toBe("111222333444555666");
		expect(ref?.from.displayName).toBe("nubs");
		expect(ref?.channelId).toBe("555");
		expect(ref?.worldId).toBe("777");
		expect(ref?.body).toBe("gm cozy devs");
		expect(ref?.receivedAtMs).toBe(1_700_000_000_000);
		expect(ref?.isRead).toBe(false);
		expect(ref?.hasAttachments).toBe(false);
	});

	it("returns null for memories missing Discord identity metadata", () => {
		const memory = discordMemory({ messageId: "123", channelId: "555" });
		memory.metadata = { type: "message" } as Memory["metadata"];
		expect(mapDiscordMemoryToRef(memory)).toBeNull();
	});

	it("clips long bodies into the snippet", () => {
		const long = "x".repeat(600);
		const ref = mapDiscordMemoryToRef(
			discordMemory({ messageId: "1", channelId: "2", text: long }),
		);
		expect(ref?.snippet.length).toBeLessThanOrEqual(240);
		expect(ref?.body).toBe(long);
	});
});

describe("DiscordTriageAdapter", () => {
	it("is unavailable when the discord service is missing or malformed", () => {
		const adapter = new DiscordTriageAdapter();
		expect(adapter.isAvailable(createRuntime(null))).toBe(false);
		expect(adapter.isAvailable(createRuntime({ notTheApi: true }))).toBe(false);
	});

	it("advertises list capability so triage sweeps engage", () => {
		const caps = new DiscordTriageAdapter().capabilities();
		expect(caps.list).toBe(true);
		expect(caps.send.reply).toBe(true);
	});

	it("returns [] (not a throw) when the service is unavailable", async () => {
		const adapter = new DiscordTriageAdapter();
		await expect(
			adapter.listMessages(createRuntime(null), {}),
		).resolves.toEqual([]);
	});

	it("sweeps discovered channels, merges, sorts desc, and applies limit", async () => {
		const now = Date.now();
		const service = createFakeDiscordService({
			channels: [{ channelId: "c1" }, { channelId: "c2" }],
			messagesByChannel: {
				c1: [
					discordMemory({
						messageId: "10",
						channelId: "c1",
						createdAt: now - 1000,
					}),
					discordMemory({
						messageId: "11",
						channelId: "c1",
						createdAt: now - 5000,
					}),
				],
				c2: [
					discordMemory({
						messageId: "20",
						channelId: "c2",
						createdAt: now - 2000,
					}),
				],
			},
		});
		const adapter = new DiscordTriageAdapter();
		const refs = await adapter.listMessages(createRuntime(service), {
			limit: 2,
		});
		expect(refs.map((r) => r.externalId)).toEqual(["10", "20"]);
	});

	it("skips the agent's own messages", async () => {
		const service = createFakeDiscordService({
			channels: [{ channelId: "c1" }],
			messagesByChannel: {
				c1: [
					discordMemory({
						messageId: "1",
						channelId: "c1",
						entityId: AGENT_ID,
					}),
					discordMemory({ messageId: "2", channelId: "c1" }),
				],
			},
		});
		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{},
		);
		expect(refs.map((r) => r.externalId)).toEqual(["2"]);
	});

	it("applies sinceMs and worldIds filters", async () => {
		const now = Date.now();
		const service = createFakeDiscordService({
			channels: [
				{ channelId: "c1", serverId: "guildA" },
				{ channelId: "c2", serverId: "guildB" },
			],
			messagesByChannel: {
				c1: [
					discordMemory({
						messageId: "old",
						channelId: "c1",
						serverId: "guildA",
						createdAt: now - 100_000,
					}),
					discordMemory({
						messageId: "new",
						channelId: "c1",
						serverId: "guildA",
						createdAt: now - 1000,
					}),
				],
				c2: [
					discordMemory({
						messageId: "other",
						channelId: "c2",
						serverId: "guildB",
						createdAt: now - 1000,
					}),
				],
			},
		});
		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{ sinceMs: now - 10_000, worldIds: ["guildA"] },
		);
		expect(refs.map((r) => r.externalId)).toEqual(["new"]);
	});

	it("continues the sweep when one channel fetch fails", async () => {
		const service = createFakeDiscordService({
			channels: [{ channelId: "locked" }, { channelId: "open" }],
			failChannels: new Set(["locked"]),
			messagesByChannel: {
				open: [discordMemory({ messageId: "42", channelId: "open" })],
			},
		});
		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{},
		);
		expect(refs.map((r) => r.externalId)).toEqual(["42"]);
	});

	it("uses explicit channelIds without discovering rooms", async () => {
		const service = createFakeDiscordService({
			channels: [{ channelId: "should-not-be-used" }],
			messagesByChannel: {
				direct: [discordMemory({ messageId: "7", channelId: "direct" })],
			},
		});
		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{ channelIds: ["direct"] },
		);
		expect(refs.map((r) => r.externalId)).toEqual(["7"]);
	});

	it("getMessage resolves refs cached by a prior list", async () => {
		const service = createFakeDiscordService({
			channels: [{ channelId: "c1" }],
			messagesByChannel: {
				c1: [discordMemory({ messageId: "77", channelId: "c1" })],
			},
		});
		const adapter = new DiscordTriageAdapter();
		const runtime = createRuntime(service);
		await adapter.listMessages(runtime, {});
		const byRefId = await adapter.getMessage(runtime, "discord:77");
		const byExternalId = await adapter.getMessage(runtime, "77");
		expect(byRefId?.externalId).toBe("77");
		expect(byExternalId?.externalId).toBe("77");
	});

	it("drafts a reply to a listed message and sends it to that channel", async () => {
		const sentMemory = discordMemory({ messageId: "900", channelId: "c1" });
		const service = createFakeDiscordService({
			channels: [{ channelId: "c1" }],
			messagesByChannel: {
				c1: [discordMemory({ messageId: "88", channelId: "c1" })],
			},
			sentMemory,
		});
		const adapter = new DiscordTriageAdapter();
		const runtime = createRuntime(service);
		await adapter.listMessages(runtime, {});

		const { draftId, preview } = await adapter.createDraft(runtime, {
			source: "discord",
			inReplyToId: "discord:88",
			to: [{ identifier: "111222333444555666" }],
			body: "on it — will take a look",
		});
		expect(preview).toContain("on it");

		const { externalId } = await adapter.sendDraft(runtime, draftId);
		expect(externalId).toBe("900");
		expect(service.sends).toHaveLength(1);
		expect(service.sends[0].target.channelId).toBe("c1");
		expect(service.sends[0].content.text).toBe("on it — will take a look");
	});

	it("rejects drafts that resolve no channel", async () => {
		const service = createFakeDiscordService({});
		await expect(
			new DiscordTriageAdapter().createDraft(createRuntime(service), {
				source: "discord",
				to: [],
				body: "hello",
			}),
		).rejects.toThrow(/channelId/);
	});

	it("sendDraft errors on unknown draft ids", async () => {
		const service = createFakeDiscordService({});
		await expect(
			new DiscordTriageAdapter().sendDraft(
				createRuntime(service),
				"discord-draft:nope",
			),
		).rejects.toThrow(/no cached draft/);
	});
});
