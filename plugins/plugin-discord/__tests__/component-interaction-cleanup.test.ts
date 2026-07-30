/**
 * Regression guard for the removal of Discord's orphaned string-select /
 * legacy-button machinery (#14527). The in-chat widget system only ever emits
 * codec buttons, so `handleInteractionCreate` must (a) replay a codec button as
 * a user turn, (b) merely acknowledge any other component, and (c) never revive
 * the dead `DISCORD_INTERACTION` dispatch — and `buildDiscordComponents` must no
 * longer build type-3 select menus. Fakes drive the real handler + builder.
 */
import { ChannelType, encodeReplyCallback } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleInteractionCreate } from "../discord-interactions";
import type { DiscordActionRow } from "../types";
import { buildDiscordComponents } from "../utils";

function makeService(messageService?: {
	handleMessage: ReturnType<typeof vi.fn>;
}) {
	const emitEvent = vi.fn();
	const runtime = {
		agentId: "agent-1",
		emitEvent,
		getSetting: vi.fn(() => undefined),
		logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
		ensureConnection: vi.fn(async () => {}),
		// Canonical-room collaborators for the delivery-audience attestation on
		// the codec-button replay turn.
		getRoom: vi.fn(async (roomId: string) => ({
			id: roomId,
			type: ChannelType.DM,
		})),
		getParticipantsForRoom: vi.fn(async () => [
			"00000000-0000-0000-0000-000000000001",
			"agent-1",
		]),
		reportError: vi.fn(),
		messageService: messageService ?? null,
	};
	return {
		accountId: "test",
		client: { user: { id: "bot-1" } },
		character: {},
		runtime,
		slashCommands: [],
		timeouts: [],
		resolveDiscordEntityId: vi.fn(() => "00000000-0000-0000-0000-000000000001"),
		getChannelType: vi.fn(async () => ChannelType.DM),
		registerSlashCommands: vi.fn(),
		refreshOwnerDiscordUserIds: vi.fn(),
		clientReadyPromise: null,
	};
}

interface FakeComponentOverrides {
	customId: string;
	isButton: boolean;
}

function makeComponentInteraction({
	customId,
	isButton,
}: FakeComponentOverrides) {
	const deferUpdate = vi.fn(async () => {});
	const channelSend = vi.fn(async () => ({}));
	return {
		id: "interaction-1",
		user: {
			id: "user-1",
			username: "alice",
			displayName: "Alice",
			bot: false,
		},
		guild: null,
		channel: { id: "dm-channel-1", send: channelSend },
		customId,
		isCommand: () => false,
		isModalSubmit: () => false,
		isMessageComponent: () => true,
		isButton: () => isButton,
		deferUpdate,
	};
}

describe("#14527 Discord component-interaction machinery cleanup", () => {
	it("replays a codec button as a user turn (no DISCORD_INTERACTION emit)", async () => {
		const handleMessage = vi.fn(async () => []);
		const service = makeService({ handleMessage });
		const codecId = encodeReplyCallback("yes", { maxBytes: 100 });
		expect(codecId).not.toBeNull();

		const interaction = makeComponentInteraction({
			customId: codecId as string,
			isButton: true,
		});

		await handleInteractionCreate(service as never, interaction as never);

		expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
		expect(handleMessage).toHaveBeenCalledTimes(1);
		const injectedMemory = handleMessage.mock.calls[0][1] as {
			content: { text: string };
		};
		expect(injectedMemory.content.text).toBe("yes");
		// The dead legacy pipeline is gone: nothing is emitted for a component tap.
		expect(service.runtime.emitEvent).not.toHaveBeenCalled();
	});

	it("acknowledges a non-codec button without routing or DISCORD_INTERACTION", async () => {
		const handleMessage = vi.fn(async () => []);
		const service = makeService({ handleMessage });
		const interaction = makeComponentInteraction({
			customId: "legacy_form_submit",
			isButton: true,
		});

		await handleInteractionCreate(service as never, interaction as never);

		expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
		expect(handleMessage).not.toHaveBeenCalled();
		expect(service.runtime.emitEvent).not.toHaveBeenCalled();
	});

	it("acknowledges a non-button component (e.g. a select) without dispatch", async () => {
		const handleMessage = vi.fn(async () => []);
		const service = makeService({ handleMessage });
		const interaction = makeComponentInteraction({
			customId: "some_select",
			isButton: false,
		});

		await handleInteractionCreate(service as never, interaction as never);

		expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
		expect(handleMessage).not.toHaveBeenCalled();
		expect(service.runtime.emitEvent).not.toHaveBeenCalled();
	});

	it("buildDiscordComponents still builds buttons but ignores orphaned type-3 select specs", () => {
		const rows: DiscordActionRow[] = [
			{
				type: 1,
				components: [{ type: 2, custom_id: "ia1:yes", label: "Yes", style: 2 }],
			},
		];
		const built = buildDiscordComponents(rows);
		expect(built).toBeDefined();
		expect(built?.length).toBe(1);
		expect(built?.[0].toJSON().components).toHaveLength(1);

		// A type-3 (string select) spec produces no component, so an action row
		// carrying only a select yields no rows at all — the build machinery for
		// selects has been removed along with the dead handle path.
		const selectOnly = [
			{
				type: 1,
				components: [
					{
						type: 3,
						custom_id: "sel",
						placeholder: "pick",
						options: [{ label: "A", value: "a" }],
					},
				],
			},
		] as unknown as DiscordActionRow[];
		expect(buildDiscordComponents(selectOnly)).toBeUndefined();
	});
});
