/**
 * Audit-log reasons go through the real discord.js REST client, which
 * URI-encodes them into the X-Audit-Log-Reason header. A local HTTP server
 * stands in for the Discord API so the request is sent for real.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { REST } from "@discordjs/rest";
import { Routes } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	executeGuildManagement,
	type ManageableChannel,
	type ManageableGuild,
} from "../guild-management";

const GUILD_ID = "223456789012345678";
const received: string[] = [];
let server: Server;
let rest: REST;

beforeAll(async () => {
	server = createServer((req, res) => {
		received.push(String(req.headers["x-audit-log-reason"] ?? ""));
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({ id: "323456789012345678", name: "planning", type: 0 }),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	rest = new REST({ api: `http://127.0.0.1:${port}`, retries: 0 }).setToken(
		"test-bot-token",
	);
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

function guildOverRest(): ManageableGuild {
	return {
		id: GUILD_ID,
		name: "Test guild",
		members: {
			me: {
				id: "423456789012345678",
				permissions: { has: () => true },
				roles: {
					highest: { position: 10 },
					cache: new Map(),
					add: async () => undefined,
					remove: async () => undefined,
				},
				kick: async () => undefined,
				timeout: async () => undefined,
			},
			fetch: async () => {
				throw new Error("not used");
			},
		},
		roles: {
			everyone: { id: GUILD_ID },
			cache: new Map(),
			fetch: async () => null,
			create: async () => {
				throw new Error("not used");
			},
		},
		channels: {
			cache: new Map(),
			fetch: async () => null,
			create: async ({ reason, ...body }) =>
				(await rest.post(Routes.guildChannels(GUILD_ID), {
					body,
					reason: reason as string | undefined,
				})) as ManageableChannel,
		},
		bans: { create: async () => undefined, remove: async () => undefined },
	};
}

describe("guild management audit-log reason", () => {
	it("sends a reason cut at Discord's 512 limit without splitting an emoji", async () => {
		const prefix = "eliza guild management: ";
		// The emoji's two code units straddle the 512 cut.
		const reason = `${"x".repeat(511 - prefix.length)}🎉 planning channel`;
		const result = await executeGuildManagement(
			{
				guild: guildOverRest(),
				gates: {
					channels: true,
					roles: false,
					permissions: false,
					moderation: false,
				},
				stateStore: { get: async () => undefined, set: async () => undefined },
			},
			{
				operation: "create_channel",
				name: "planning",
				channelType: "text",
				reason,
			},
		);
		expect(result.entries[0]).toMatchObject({ action: "created" });
		const sent = decodeURIComponent(received.at(-1) ?? "");
		expect(sent.isWellFormed()).toBe(true);
		expect(sent).toBe(`${prefix}${"x".repeat(511 - prefix.length)}`);
	});
});
