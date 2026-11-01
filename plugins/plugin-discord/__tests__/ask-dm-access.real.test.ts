/**
 * `/ask` in a DM is gated by the DM settings of the account that received the
 * interaction, the same settings the message path uses for that account. The
 * interaction goes through the real `interactionCreate` listener and slash
 * dispatcher on a real AgentRuntime with PGlite; the Discord client, the
 * account's service facade and the interaction are stand-ins.
 */
import { stringToUuid } from "@elizaos/core";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "@elizaos/testing/runtime";
import type { Interaction } from "discord.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelDebouncer } from "../debouncer.ts";
import { setupDiscordEventListeners } from "../discord-events.ts";
import { checkDiscordDmAccess } from "../dm-access.ts";
import type { DiscordSettings } from "../types.ts";

const DM_REFUSAL = "Direct messages are not available for this account.";
// The test runtime has no message service, so a sender who passes the DM gate
// gets this reply from the next step of `/ask`.
const PASSED_DM_GATE = "The agent runtime isn't ready to answer right now.";
const ALLOWED_SENDER = "700000000000000001";

let fixture: TestRuntimeResult;
const debouncers: ChannelDebouncer[] = [];

beforeAll(async () => {
	// The base settings admit every DM, so a refusal can only come from the
	// receiving account's own settings.
	fixture = await createTestRuntime({
		settings: {
			DISCORD_DM_POLICY: "open",
			DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES: "false",
		},
	});
}, 180_000);

afterAll(async () => {
	for (const debouncer of debouncers) debouncer.destroy();
	await fixture?.cleanup();
});

/** Registers the account's listeners and returns its `interactionCreate` listener. */
function interactionListenerFor(
	accountId: string,
	settings: DiscordSettings,
): (interaction: Interaction) => Promise<void> {
	const listeners = new Map<string, (...args: never[]) => unknown>();
	const service = {
		accountId,
		runtime: fixture.runtime,
		client: {
			user: { id: "799999999999999999" },
			on: (event: string, listener: (...args: never[]) => unknown) => {
				listeners.set(event, listener);
			},
			once() {},
		},
		discordSettings: { ...settings, shouldIgnoreBotMessages: false },
		allowedChannelIds: undefined,
		allowAllSlashCommands: new Set<string>(),
		slashCommands: [],
		timeouts: [],
		clientReadyPromise: null,
		isChannelAllowed: () => true,
		resolveDiscordEntityId: (userId: string) =>
			stringToUuid(`discord-user-${userId}`),
		handleInteractionCreate: async () => {},
	};
	const { channelDebouncer } = setupDiscordEventListeners(
		service as unknown as Parameters<typeof setupDiscordEventListeners>[0],
	);
	debouncers.push(channelDebouncer);
	const listener = listeners.get("interactionCreate");
	if (!listener) throw new Error("interactionCreate listener not registered");
	return listener as (interaction: Interaction) => Promise<void>;
}

/** Sends `/ask` from a bot DM to the account and returns the replies. */
async function askInDm(
	accountId: string,
	settings: DiscordSettings,
	userId: string,
): Promise<string[]> {
	const replies: string[] = [];
	const interaction = {
		id: `ask-${accountId}-${userId}`,
		type: 2,
		commandName: "ask",
		user: { id: userId, username: `user${userId}`, displayName: null },
		channelId: `dm-${userId}`,
		channel: null,
		guildId: null,
		guild: null,
		deferred: false,
		replied: false,
		inGuild: () => false,
		isAutocomplete: () => false,
		isCommand: () => true,
		isChatInputCommand: () => true,
		isModalSubmit: () => false,
		isMessageComponent: () => false,
		options: { getString: () => "hello" },
		reply: async (payload: { content: string }) => {
			replies.push(payload.content);
		},
		deferReply: async () => {},
		editReply: async (payload: unknown) => {
			replies.push(
				typeof payload === "string" ? payload : JSON.stringify(payload),
			);
		},
	} as unknown as Interaction;

	await interactionListenerFor(accountId, settings)(interaction);
	return replies;
}

describe("/ask DM access for the receiving account", () => {
	it("refuses a DM when the account disables DMs", async () => {
		expect(
			await askInDm(
				"locked",
				{ dmPolicy: "disabled", shouldIgnoreDirectMessages: false },
				"700000000000000010",
			),
		).toEqual([DM_REFUSAL]);
		expect(
			await askInDm(
				"public",
				{ dmPolicy: "open", shouldIgnoreDirectMessages: false },
				"700000000000000011",
			),
		).toEqual([PASSED_DM_GATE]);
	});

	it("refuses a DM when the account ignores DMs, except allowFrom senders", async () => {
		const settings: DiscordSettings = {
			dmPolicy: "open",
			shouldIgnoreDirectMessages: true,
			allowFrom: [ALLOWED_SENDER],
		};
		expect(await askInDm("members", settings, "700000000000000020")).toEqual([
			DM_REFUSAL,
		]);
		expect(await askInDm("members", settings, ALLOWED_SENDER)).toEqual([
			PASSED_DM_GATE,
		]);
	});

	it("denies an ignored DM with no reply, so the message path stays silent", async () => {
		expect(
			await checkDiscordDmAccess(
				fixture.runtime,
				{ dmPolicy: "open", shouldIgnoreDirectMessages: true },
				{ id: "700000000000000030", username: "user700000000000000030" },
			),
		).toEqual({ allowed: false });
	});
});
