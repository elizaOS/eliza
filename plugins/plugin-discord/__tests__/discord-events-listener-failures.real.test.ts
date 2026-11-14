/** Discord gateway emissions must record a real runtime subscriber failure. */
import { EventEmitter } from "node:events";
import { AgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { setupDiscordEventListeners } from "../discord-events.ts";
import { DiscordEventTypes } from "../types.ts";

const guild = {
	id: "guild-1",
	name: "Guild One",
	fetchAuditLogs: async () => {
		throw new Error("missing permissions");
	},
};
const role = {
	id: "role-1",
	name: "Moderator",
	permissions: { toArray: () => ["ManageGuild"] },
	guild,
};

it.each([
	["roleCreate", DiscordEventTypes.ROLE_CREATED],
	["roleDelete", DiscordEventTypes.ROLE_DELETED],
])(
	"records a real runtime listener failure from %s",
	async (gatewayEvent, event) => {
		const runtime = new AgentRuntime({
			character: {
				name: `Discord listener failure ${gatewayEvent}`,
				bio: [],
				settings: { DISCORD_AUDIT_LOG_ENABLED: "true" },
			},
		});
		const client = Object.assign(new EventEmitter(), { user: { id: "bot-1" } });
		runtime.registerEvent(event, async () => {
			throw new Error("real listener failure");
		});
		const { channelDebouncer } = setupDiscordEventListeners({
			runtime,
			client,
			messageManager: { handleMessage: async () => {} },
			discordSettings: {},
		} as unknown as Parameters<typeof setupDiscordEventListeners>[0]);
		try {
			// EventEmitter, like discord.js, ignores a returned promise.
			client.emit(gatewayEvent, role);
			await vi.waitFor(() => {
				expect(runtime.getRecentReportedErrors()).toEqual([
					expect.objectContaining({
						scope: "discord:emit-event",
						message: "real listener failure",
					}),
				]);
			});
		} finally {
			channelDebouncer.destroy();
			client.removeAllListeners();
		}
	},
);
