import type {
	Content,
	IAgentRuntime,
	Memory,
	MessageConnectorQueryContext,
	MessageConnectorTarget,
	TargetInfo,
	UUID,
} from "@elizaos/core";
import { DiscordSnowflake } from "@sapphire/snowflake";
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

	it("preserves complete long bodies in the model-facing snippet", () => {
		const long = `${"x".repeat(600)}tail`;
		const ref = mapDiscordMemoryToRef(
			discordMemory({ messageId: "1", channelId: "2", text: long }),
		);
		expect(ref?.snippet).toBe(long);
		expect(ref?.body).toBe(long);
	});
});

describe("DiscordTriageAdapter", () => {
	it("stops paging a channel whose reads ignore the before cursor", async () => {
		const page = Array.from({ length: 100 }, (_, index) =>
			discordMemory({
				messageId: String(1_000 - index),
				channelId: "555",
				entityId: AGENT_ID,
			}),
		);
		let calls = 0;
		const service = {
			...createFakeDiscordService(),
			async fetchConnectorMessages(): Promise<Memory[]> {
				calls += 1;
				return page;
			},
		};

		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{ channelIds: ["555"], limit: 3 },
		);

		expect(refs).toEqual([]);
		expect(calls).toBe(2);
	});

	it("pages past the agent's own replies in full history pages", async () => {
		// Newest first, as Discord returns them: ids 250..1, where the agent
		// wrote everything newer than id 20.
		const history = Array.from({ length: 250 }, (_, index) => {
			const id = 250 - index;
			return discordMemory({
				messageId: String(id),
				channelId: "555",
				serverId: "777",
				entityId: id > 20 ? AGENT_ID : USER_ID,
				createdAt: 1_000 + id,
			});
		});
		const fetches: Array<{ limit?: number; before?: string }> = [];
		const service = {
			...createFakeDiscordService({
				channels: [{ channelId: "555", serverId: "777" }],
			}),
			async fetchConnectorMessages(
				_context: MessageConnectorQueryContext,
				params: { channelId?: string; limit?: number; before?: string },
			): Promise<Memory[]> {
				fetches.push({ limit: params.limit, before: params.before });
				const older = params.before
					? history.filter(
							(memory) =>
								BigInt(String(memory.metadata?.discordMessageId)) <
								BigInt(params.before as string),
						)
					: history;
				return params.limit === undefined
					? older
					: older.slice(0, params.limit);
			},
		};

		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{ channelIds: ["555"], limit: 3 },
		);

		expect(refs.map((ref) => ref.externalId)).toEqual(["20", "19", "18"]);
		expect(fetches).toEqual([
			{ limit: 100, before: undefined },
			{ limit: 100, before: "151" },
			{ limit: 100, before: "51" },
		]);
	});

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

	it("preserves every discovered channel and message when limit is omitted", async () => {
		const channels = Array.from({ length: 30 }, (_, index) => ({
			channelId: `c${index}`,
		}));
		const messagesByChannel = Object.fromEntries(
			channels.map(({ channelId }, channelIndex) => [
				channelId,
				Array.from({ length: 20 }, (_, messageIndex) =>
					discordMemory({
						messageId: `${channelIndex}-${messageIndex}`,
						channelId,
						createdAt: channelIndex * 100 + messageIndex,
					}),
				),
			]),
		);
		const service = createFakeDiscordService({ channels, messagesByChannel });

		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{},
		);

		expect(refs).toHaveLength(600);
		expect(new Set(refs.map((ref) => ref.channelId)).size).toBe(30);
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

	it("preserves complete long draft previews and valid surrogate pairs", async () => {
		const service = createFakeDiscordService({
			channels: [{ channelId: "c1" }],
			messagesByChannel: {
				c1: [discordMemory({ messageId: "89", channelId: "c1" })],
			},
		});
		const runtime = createRuntime(service);
		const adapter = new DiscordTriageAdapter();
		await adapter.listMessages(runtime, {});

		const longBody = `${"a".repeat(240)}🦊${"b".repeat(500)}tail`;
		const { preview } = await adapter.createDraft(runtime, {
			source: "discord",
			inReplyToId: "discord:89",
			to: [{ identifier: "111222333444555666" }],
			body: longBody,
		});

		expect(preview.isWellFormed()).toBe(true);
		expect(preview).toBe(longBody);
		expect(preview.endsWith("tail")).toBe(true);
	});

	it("passes the period start as the after boundary on an unlimited sweep", async () => {
		const sinceMs = Date.UTC(2026, 0, 1);
		// The first and the last id one millisecond can hold.
		const firstIdAt = (timestamp: number) =>
			DiscordSnowflake.generate({
				timestamp,
				increment: 0n,
				workerId: 0n,
				processId: 0n,
			});
		const lastIdAt = (timestamp: number) =>
			DiscordSnowflake.generate({
				timestamp,
				increment: 0xfffn,
				workerId: 0b11111n,
				processId: 0b11111n,
			});
		const fetches: Array<{
			channelId?: string;
			limit?: number;
			before?: string;
			after?: string;
		}> = [];
		const service = {
			...createFakeDiscordService({
				channels: [{ channelId: "c1" }, { channelId: "c2" }],
			}),
			async fetchConnectorMessages(
				_context: MessageConnectorQueryContext,
				params: (typeof fetches)[number],
			): Promise<Memory[]> {
				fetches.push({ ...params });
				return [];
			},
		};

		await new DiscordTriageAdapter().listMessages(createRuntime(service), {
			sinceMs,
		});

		expect(fetches.map((fetch) => fetch.channelId)).toEqual(["c1", "c2"]);
		for (const fetch of fetches) {
			expect(fetch.limit).toBeUndefined();
			expect(fetch.before).toBeUndefined();
			const boundary = BigInt(fetch.after as string);
			// The first id of the period is kept; the last id before it is not.
			expect(firstIdAt(sinceMs) > boundary).toBe(true);
			expect(lastIdAt(sinceMs - 1) <= boundary).toBe(true);
		}
	});

	// The service refuses `before` together with `after`, so a limited read
	// must page by its own cursor alone.
	it("pages a limited sinceMs read with its before cursor only", async () => {
		const sinceMs = Date.UTC(2026, 0, 1);
		// Newest first, one message a second: the period starts at the 50th,
		// the user wrote up to the 60th and the agent everything newer.
		const history = Array.from({ length: 200 }, (_, index) => {
			const createdAt = sinceMs + (150 - index) * 1_000;
			return discordMemory({
				messageId: DiscordSnowflake.generate({
					timestamp: createdAt,
				}).toString(),
				channelId: "555",
				entityId: index < 140 ? AGENT_ID : USER_ID,
				createdAt,
			});
		});
		const idOf = (memory: Memory) =>
			BigInt(String(memory.metadata?.discordMessageId));
		const service = {
			...createFakeDiscordService(),
			async fetchConnectorMessages(
				_context: MessageConnectorQueryContext,
				params: { limit?: number; before?: string; after?: string },
			): Promise<Memory[]> {
				const { limit, before, after } = params;
				if (before && after) {
					throw new RangeError(
						"Discord message reads cannot combine before/cursor with after",
					);
				}
				return history
					.filter((memory) => !before || idOf(memory) < BigInt(before))
					.filter((memory) => !after || idOf(memory) > BigInt(after))
					.slice(0, limit);
			},
		};

		const refs = await new DiscordTriageAdapter().listMessages(
			createRuntime(service),
			{ channelIds: ["555"], limit: 5, sinceMs },
		);

		expect(refs.map((ref) => ref.externalId)).toEqual(
			history.slice(140, 145).map((memory) => String(idOf(memory))),
		);
	});
});
