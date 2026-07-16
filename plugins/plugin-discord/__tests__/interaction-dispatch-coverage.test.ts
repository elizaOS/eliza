/**
 * Behavioral coverage for the non-button branches of
 * `handleInteractionCreate` and the guild sync builders in
 * `discord-interactions.ts` — slash commands emit `SLASH_COMMAND`, modal
 * submits emit `MODAL_SUBMIT`, a non-codec component is acknowledged
 * (`deferUpdate`) without a dispatch, and `buildStandardizedRooms` /
 * `buildStandardizedUsers` map a fake guild's channels/members into the
 * runtime's room/entity records. Only discord.js SDK objects are stubbed —
 * no bot token, no network. Complements `interaction-replay-render.test.ts`
 * (the codec-button branch).
 */
import { ChannelType as DiscordChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
	buildStandardizedRooms,
	buildStandardizedUsers,
	handleInteractionCreate,
} from "../discord-interactions";

const noop = () => {};
const BOT_ID = "888000000000000000";
const GUILD_ID = "700000000000000000";

function makeService(overrides: Record<string, unknown> = {}) {
	const emitEvent = vi.fn();
	const service = {
		accountId: "default",
		client: { user: { id: BOT_ID }, users: { fetch: vi.fn() } },
		slashCommands: [],
		resolveDiscordEntityId: vi.fn(
			(id: string) =>
				`00000000-0000-0000-0000-${id.slice(-12).padStart(12, "0")}`,
		),
		getChannelType: vi.fn(async () => "GROUP"),
		registerSlashCommands: vi.fn(),
		refreshOwnerDiscordUserIds: vi.fn(),
		discordSettings: {},
		runtime: {
			agentId: "00000000-0000-0000-0000-0000000000aa",
			emitEvent,
			ensureConnection: vi.fn(async () => {}),
			getSetting: () => undefined,
			logger: { info: noop, warn: noop, debug: noop, error: noop },
		},
		...overrides,
	};
	return { service, emitEvent };
}

function baseInteraction(kind: "command" | "modal" | "component") {
	return {
		id: "interaction-1",
		user: {
			id: "user-1",
			username: "alice",
			displayName: "Alice",
			discriminator: "0",
			bot: false,
		},
		guild: null,
		channel: { id: "chan-1" },
		channelId: "chan-1",
		commandName: "help",
		commandType: 1,
		customId: "raw-noncodec-button",
		inGuild: () => false,
		isCommand: () => kind === "command",
		isModalSubmit: () => kind === "modal",
		isMessageComponent: () => kind === "component",
		isButton: () => kind === "component",
		isStringSelectMenu: () => false,
		deferUpdate: vi.fn(async () => {}),
	};
}

describe("handleInteractionCreate dispatch branches", () => {
	it("emits SLASH_COMMAND for a command interaction", async () => {
		const { service, emitEvent } = makeService();
		await handleInteractionCreate(
			service as never,
			baseInteraction("command") as never,
		);
		const events = emitEvent.mock.calls.map((c) => c[0]);
		expect(events).toContain("DISCORD_SLASH_COMMAND");
	});

	it("emits MODAL_SUBMIT for a modal submit interaction", async () => {
		const { service, emitEvent } = makeService();
		await handleInteractionCreate(
			service as never,
			baseInteraction("modal") as never,
		);
		const events = emitEvent.mock.calls.map((c) => c[0]);
		expect(events).toContain("DISCORD_MODAL_SUBMIT");
	});

	it("acknowledges a non-codec component without dispatching a turn", async () => {
		const { service, emitEvent } = makeService();
		const interaction = baseInteraction("component");
		await handleInteractionCreate(service as never, interaction as never);
		// A raw (non-codec) button carries no submit semantics — it is only
		// deferUpdate'd to clear the client loading state.
		expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("resolves the guild channel type + server id for an in-guild command", async () => {
		const { service, emitEvent } = makeService();
		const interaction = {
			...baseInteraction("command"),
			guild: {
				id: GUILD_ID,
				name: "Test Guild",
				ownerId: "111111111111111111",
				fetch: vi.fn(async function fetchGuild() {
					return interaction.guild;
				}),
			},
			channel: { id: "chan-1", name: "general" },
			inGuild: () => true,
		};
		await handleInteractionCreate(service as never, interaction as never);
		expect(interaction.guild.fetch).toHaveBeenCalled();
		expect(service.getChannelType).toHaveBeenCalled();
		expect(emitEvent.mock.calls.map((c) => c[0])).toContain(
			"DISCORD_SLASH_COMMAND",
		);
	});
});

describe("guild sync builders", () => {
	function member(id: string, username: string, bot: boolean) {
		return {
			id,
			displayName: username,
			user: {
				id,
				username,
				bot,
				discriminator: "0",
				globalName: null,
				displayAvatarURL: () => `https://cdn.discord.test/${id}.png`,
			},
		};
	}

	function makeGuild() {
		return {
			id: GUILD_ID,
			name: "Test Guild",
			memberCount: 3,
			channels: {
				cache: new Map<string, { id: string; name: string; type: number }>([
					[
						"c-text",
						{
							id: "c-text",
							name: "general",
							type: DiscordChannelType.GuildText,
						},
					],
					[
						"c-voice",
						{
							id: "c-voice",
							name: "Voice",
							type: DiscordChannelType.GuildVoice,
						},
					],
					[
						"c-cat",
						{
							id: "c-cat",
							name: "Category",
							type: DiscordChannelType.GuildCategory,
						},
					],
				]),
			},
			members: {
				fetch: vi.fn(),
				cache: new Map([
					[BOT_ID, member(BOT_ID, "bot", true)],
					["m-1", member("m-1", "human", false)],
				]),
			},
		};
	}

	it("maps text/voice channels into rooms and skips categories", async () => {
		const { service } = makeService();
		const rooms = await buildStandardizedRooms(
			service as never,
			makeGuild() as never,
			"00000000-0000-0000-0000-000000000fff" as never,
		);
		expect(rooms.length).toBe(2);
		expect(rooms.every((room) => typeof room.id === "string")).toBe(true);
	});

	it("maps guild members into entities", async () => {
		const { service } = makeService();
		const entities = await buildStandardizedUsers(
			service as never,
			makeGuild() as never,
		);
		expect(entities.length).toBeGreaterThanOrEqual(1);
	});

	it("uses the optimized cache path for a large guild (>1000 members)", async () => {
		const { service } = makeService();
		const guild = { ...makeGuild(), memberCount: 5000 };
		const entities = await buildStandardizedUsers(
			service as never,
			guild as never,
		);
		// The bot itself is excluded; the one human member survives.
		expect(entities.flatMap((entity) => entity.names)).toContain("human");
	});
});
