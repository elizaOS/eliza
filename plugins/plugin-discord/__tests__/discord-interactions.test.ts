import { ChannelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleInteractionCreate, onReady } from "../discord-interactions";

function makeService() {
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001",
		ensureConnection: vi.fn(),
		emitEvent: vi.fn(),
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			success: vi.fn(),
		},
		getSetting: vi.fn(() => undefined),
		registerEvent: vi.fn(),
		character: { name: "TestBot" },
	};
	const memberCache = new Map([
		["u1", { id: "u1", user: { id: "u1", username: "alice" } }],
	]);
	const fullGuild = {
		id: "g1",
		name: "Guild",
		ownerId: "o1",
		memberCount: 2,
		channels: {
			cache: new Map([
				[
					"chan1",
					{
						id: "chan1",
						type: 0,
						name: "general",
						permissionsFor: () => ({ has: () => true }),
					},
				],
			]),
		},
		members: {
			cache: memberCache,
			fetch: async () => memberCache,
		},
	};
	const service = {
		runtime,
		accountId: undefined,
		resolveDiscordEntityId: (id: string) => `entity-${id}`,
		getChannelType: async () => ChannelType.GROUP,
		client: {
			user: { id: "999", username: "bot" },
			guilds: {
				fetch: async () =>
					new Map([
						["g1", { id: "g1", name: "Guild", fetch: async () => fullGuild }],
					]),
			},
			emit: vi.fn(),
		},
		slashCommands: [],
		refreshOwnerDiscordUserIds: vi.fn(),
		registerSlashCommands: vi.fn(),
		discordSettings: {},
		timeouts: [] as ReturnType<typeof setTimeout>[],
	};
	return { runtime, service };
}

function baseInteraction(overrides: Record<string, unknown>) {
	return {
		user: {
			id: "u1",
			bot: false,
			username: "alice",
			discriminator: "0",
			displayName: "Alice",
		},
		channel: { id: "chan1", name: "general" },
		guild: undefined,
		isCommand: () => false,
		isModalSubmit: () => false,
		isMessageComponent: () => false,
		isButton: () => false,
		commandName: "test",
		commandType: 1,
		channelId: "chan1",
		inGuild: () => false,
		...overrides,
	};
}

describe("Discord interaction listener failures", () => {
	it("reports a slash command listener failure instead of dropping it", async () => {
		const { runtime, service } = makeService();
		runtime.emitEvent.mockRejectedValueOnce(new Error("listener boom"));

		await handleInteractionCreate(
			service as never,
			baseInteraction({ isCommand: () => true }) as never,
		);

		expect(runtime.reportError).toHaveBeenCalledWith(
			"discord:emit-event",
			expect.any(Error),
			expect.objectContaining({ accountId: "default" }),
		);
	});

	it("reports a modal submit listener failure instead of dropping it", async () => {
		const { runtime, service } = makeService();
		runtime.emitEvent.mockRejectedValueOnce(new Error("listener boom"));

		await handleInteractionCreate(
			service as never,
			baseInteraction({ isModalSubmit: () => true }) as never,
		);

		expect(runtime.reportError).toHaveBeenCalledWith(
			"discord:emit-event",
			expect.any(Error),
			expect.objectContaining({ accountId: "default" }),
		);
	});

	it("reports world connection listener failures instead of dropping them", async () => {
		const { runtime, service } = makeService();
		runtime.emitEvent.mockRejectedValue(new Error("listener boom"));

		await onReady(
			service as never,
			{
				user: { id: "999", username: "bot" },
			} as never,
		);
		await new Promise((resolve) => setTimeout(resolve, 1500));

		expect(runtime.reportError).toHaveBeenCalledTimes(2);
		expect(runtime.reportError).toHaveBeenNthCalledWith(
			1,
			"discord:emit-event",
			expect.any(Error),
			expect.objectContaining({ accountId: "default" }),
		);
		expect(runtime.reportError).toHaveBeenNthCalledWith(
			2,
			"discord:emit-event",
			expect.any(Error),
			expect.objectContaining({ accountId: "default" }),
		);
	});
});
