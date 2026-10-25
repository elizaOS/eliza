/**
 * Profile lookups must call discord.js manager methods with their receiver
 * attached (UserManager/ChannelManager/MessageManager read cache, client and
 * REST state from `this`), and must negative-cache only Discord's explicit
 * Unknown User (10013), Unknown Message (10008) and Unknown Channel (10003)
 * results. Transient failures stay retryable. The fake managers below are
 * classes whose `fetch` dereferences `this`, so a destructured call
 * (`const { fetch } = client.users`) throws and these assertions fail.
 */
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	__resetProfileCachesForTests,
	resolveDiscordMessageAuthorProfile,
	resolveDiscordRoomProfile,
	resolveDiscordUserProfile,
} from "../discord-profiles.ts";

type Outcome = unknown | Error;

function discordApiError(code: number): Error & { code: number } {
	return Object.assign(new Error(`Discord API error ${code}`), { code });
}

class FakeManager {
	readonly calls: string[] = [];
	private readonly outcomes = new Map<string, Outcome[]>();

	queue(id: string, ...outcomes: Outcome[]): void {
		this.outcomes.set(id, [...(this.outcomes.get(id) ?? []), ...outcomes]);
	}

	async fetch(id: string): Promise<unknown> {
		// Dereferences `this`: an unbound call throws a TypeError.
		this.calls.push(id);
		const next = this.outcomes.get(id)?.shift();
		if (next instanceof Error) throw next;
		if (next === undefined) throw new Error(`no outcome queued for ${id}`);
		return next;
	}
}

class FakeChannelManager extends FakeManager {
	readonly cache = new Map<string, unknown>();
}

function fakeUser(id: string, name: string) {
	return {
		id,
		username: name.toLowerCase(),
		globalName: name,
		displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}.png`,
	};
}

function makeRuntime(client: {
	users?: FakeManager;
	channels?: FakeChannelManager;
}): AgentRuntime {
	return {
		getService: (name: string) => (name === "discord" ? { client } : null),
	} as unknown as AgentRuntime;
}

describe("discord profile lookups keep manager receivers", () => {
	beforeEach(() => {
		__resetProfileCachesForTests();
	});

	describe("resolveDiscordUserProfile", () => {
		it("resolves through UserManager.fetch and caches the profile", async () => {
			const users = new FakeManager();
			users.queue("u1", fakeUser("u1", "Alice"));
			const runtime = makeRuntime({ users });

			const first = await resolveDiscordUserProfile(runtime, "u1");
			expect(first).toEqual({
				displayName: "Alice",
				username: "alice",
				avatarUrl: "https://cdn.discordapp.com/avatars/u1.png",
			});

			const second = await resolveDiscordUserProfile(runtime, "u1");
			expect(second).toEqual(first);
			expect(users.calls).toEqual(["u1"]);
		});

		it("does not cache a transient failure", async () => {
			const users = new FakeManager();
			users.queue(
				"u1",
				new Error("503 Service Unavailable"),
				fakeUser("u1", "Alice"),
			);
			const runtime = makeRuntime({ users });

			expect(await resolveDiscordUserProfile(runtime, "u1")).toBeNull();
			expect(await resolveDiscordUserProfile(runtime, "u1")).toMatchObject({
				displayName: "Alice",
			});
			expect(users.calls).toEqual(["u1", "u1"]);
		});

		it("negative-caches Unknown User (10013)", async () => {
			const users = new FakeManager();
			users.queue("u1", discordApiError(10_013));
			const runtime = makeRuntime({ users });

			expect(await resolveDiscordUserProfile(runtime, "u1")).toBeNull();
			expect(await resolveDiscordUserProfile(runtime, "u1")).toBeNull();
			expect(users.calls).toEqual(["u1"]);
		});
	});

	describe("resolveDiscordMessageAuthorProfile", () => {
		function channelWithMessages(messages: FakeManager) {
			return { id: "c1", messages };
		}

		it("resolves through ChannelManager and MessageManager and caches", async () => {
			const channels = new FakeChannelManager();
			const messages = new FakeManager();
			channels.queue("c1", channelWithMessages(messages));
			messages.queue("m1", {
				author: fakeUser("u1", "Alice"),
				member: { displayName: "Alice (server)" },
			});
			const runtime = makeRuntime({ channels });

			const first = await resolveDiscordMessageAuthorProfile(
				runtime,
				"c1",
				"m1",
			);
			expect(first).toEqual({
				displayName: "Alice (server)",
				username: "alice",
				avatarUrl: "https://cdn.discordapp.com/avatars/u1.png",
				rawUserId: "u1",
			});

			const second = await resolveDiscordMessageAuthorProfile(
				runtime,
				"c1",
				"m1",
			);
			expect(second).toEqual(first);
			expect(channels.calls).toEqual(["c1"]);
			expect(messages.calls).toEqual(["m1"]);
		});

		it("does not cache a transient channel fetch failure", async () => {
			const channels = new FakeChannelManager();
			const messages = new FakeManager();
			channels.queue(
				"c1",
				new Error("ECONNRESET"),
				channelWithMessages(messages),
			);
			messages.queue("m1", { author: fakeUser("u1", "Alice") });
			const runtime = makeRuntime({ channels });

			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toBeNull();
			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toMatchObject({ displayName: "Alice", rawUserId: "u1" });
			expect(channels.calls).toEqual(["c1", "c1"]);
		});

		it("does not cache a transient message fetch failure", async () => {
			const channels = new FakeChannelManager();
			const messages = new FakeManager();
			channels.cache.set("c1", channelWithMessages(messages));
			messages.queue("m1", new Error("500 Internal Server Error"), {
				author: fakeUser("u1", "Alice"),
			});
			const runtime = makeRuntime({ channels });

			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toBeNull();
			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toMatchObject({ displayName: "Alice" });
			expect(messages.calls).toEqual(["m1", "m1"]);
		});

		it("negative-caches Unknown Channel (10003)", async () => {
			const channels = new FakeChannelManager();
			channels.queue("c1", discordApiError(10_003));
			const runtime = makeRuntime({ channels });

			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toBeNull();
			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toBeNull();
			expect(channels.calls).toEqual(["c1"]);
		});

		it("negative-caches Unknown Message (10008)", async () => {
			const channels = new FakeChannelManager();
			const messages = new FakeManager();
			channels.cache.set("c1", channelWithMessages(messages));
			messages.queue("m1", discordApiError(10_008));
			const runtime = makeRuntime({ channels });

			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toBeNull();
			expect(
				await resolveDiscordMessageAuthorProfile(runtime, "c1", "m1"),
			).toBeNull();
			expect(messages.calls).toEqual(["m1"]);
		});
	});

	describe("resolveDiscordRoomProfile", () => {
		it("resolves a named channel through ChannelManager.fetch", async () => {
			const channels = new FakeChannelManager();
			channels.queue("c1", { id: "c1", name: " general " });
			const runtime = makeRuntime({ channels });

			expect(await resolveDiscordRoomProfile(runtime, undefined, "c1")).toEqual(
				{ title: "general" },
			);
			expect(channels.calls).toEqual(["c1"]);
		});

		it("resolves a DM channel title and avatar from its recipient", async () => {
			const channels = new FakeChannelManager();
			channels.queue("dm1", { id: "dm1", recipient: fakeUser("u1", "Alice") });
			const runtime = makeRuntime({ channels });

			expect(
				await resolveDiscordRoomProfile(runtime, undefined, "dm1"),
			).toEqual({
				title: "Alice",
				avatarUrl: "https://cdn.discordapp.com/avatars/u1.png",
			});
		});
	});
});
