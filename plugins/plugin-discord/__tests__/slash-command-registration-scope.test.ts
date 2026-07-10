/**
 * Exercises the real Discord service registration method against an in-memory
 * Discord API boundary so global and guild command scopes cannot overlap.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DiscordService } from "../service";
import type { DiscordSlashCommand } from "../types";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function command(
	name: string,
	scope: { guildOnly?: boolean; guildIds?: string[] } = {},
): DiscordSlashCommand {
	return {
		name,
		description: `${name} command`,
		...scope,
		execute: vi.fn(async () => undefined),
	} as unknown as DiscordSlashCommand;
}

function makeService() {
	const globalAndGuildSet = vi.fn(async () => undefined);
	const targetedCreate = vi.fn(async () => undefined);
	const targetedFetch = vi.fn(async () => ({ find: () => undefined }));
	const guild = {
		id: "guild-a",
		name: "Guild A",
		fetch: vi.fn(async () => ({
			commands: { fetch: targetedFetch, create: targetedCreate },
		})),
	};
	const client = {
		application: { commands: { set: globalAndGuildSet } },
		guilds: { cache: new Map([[guild.id, guild]]) },
	};
	const state = {
		accountId: "default",
		clientReadyPromise: Promise.resolve(),
		client,
	};
	const runtime = {
		agentId: AGENT_ID,
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
	const service = Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		slashCommands: [],
		allowAllSlashCommands: new Set<string>(),
		commandRegistrationQueue: Promise.resolve(),
		requireAccountState: () => state,
	}) as DiscordService;

	return { globalAndGuildSet, service, targetedCreate };
}

describe("Discord slash-command registration scopes", () => {
	it("keeps global commands out of guild scope while retaining guild-only and targeted commands", async () => {
		const { globalAndGuildSet, service, targetedCreate } = makeService();

		await service.registerSlashCommands([
			command("global"),
			command("guild-only", { guildOnly: true }),
			command("targeted", { guildIds: ["guild-a"] }),
		]);

		expect(globalAndGuildSet).toHaveBeenNthCalledWith(
			1,
			expect.arrayContaining([expect.objectContaining({ name: "global" })]),
		);
		expect(globalAndGuildSet.mock.calls[0]?.[0]).toHaveLength(1);
		expect(globalAndGuildSet).toHaveBeenNthCalledWith(
			2,
			[expect.objectContaining({ name: "guild-only" })],
			"guild-a",
		);
		expect(targetedCreate).toHaveBeenCalledWith(
			expect.objectContaining({ name: "targeted" }),
		);
	});

	it("writes an empty guild scope to clear stale copies of global commands", async () => {
		const { globalAndGuildSet, service } = makeService();

		await service.registerSlashCommands([command("global")]);

		expect(globalAndGuildSet).toHaveBeenNthCalledWith(1, [
			expect.objectContaining({ name: "global" }),
		]);
		expect(globalAndGuildSet).toHaveBeenNthCalledWith(2, [], "guild-a");
	});

	it("surfaces a failed guild write via reportError and still syncs the other guilds", async () => {
		const guildSet = vi.fn(async (_cmds: unknown, guildId?: string) => {
			if (guildId === "guild-a") throw new Error("50001: Missing Access");
			return undefined;
		});
		const reportError = vi.fn();
		const guildB = {
			id: "guild-b",
			name: "Guild B",
			fetch: vi.fn(async () => ({
				commands: { fetch: vi.fn(), create: vi.fn() },
			})),
		};
		const guildA = { ...guildB, id: "guild-a", name: "Guild A" };
		const client = {
			application: { commands: { set: guildSet } },
			guilds: {
				cache: new Map([
					["guild-a", guildA],
					["guild-b", guildB],
				]),
			},
		};
		const state = {
			accountId: "default",
			clientReadyPromise: Promise.resolve(),
			client,
		};
		const runtime = {
			agentId: AGENT_ID,
			getSetting: vi.fn(() => undefined),
			reportError,
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		} as unknown as IAgentRuntime;
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			slashCommands: [],
			allowAllSlashCommands: new Set<string>(),
			commandRegistrationQueue: Promise.resolve(),
			requireAccountState: () => state,
		}) as DiscordService;

		await service.registerSlashCommands([command("global")]);

		// Both guilds were attempted — one guild's Missing Access must not
		// abort the fan-out.
		const guildScopeCalls = guildSet.mock.calls.filter(
			(call) => typeof call[1] === "string",
		);
		expect(guildScopeCalls.map((call) => call[1]).sort()).toEqual([
			"guild-a",
			"guild-b",
		]);
		// The partial sync is observable, not a healthy-looking startup.
		expect(reportError).toHaveBeenCalledWith(
			"DiscordService.commandSync",
			expect.any(Error),
			expect.objectContaining({ guildId: "guild-a" }),
		);
	});
});

describe("handleGuildCreate registration scopes", () => {
	async function runGuildCreate(opts: {
		commands: DiscordSlashCommand[];
		setImpl?: (cmds: unknown, guildId?: string) => Promise<unknown>;
	}) {
		const { handleGuildCreate } = await import("../discord-commands");
		const guildScopeSet = vi.fn(opts.setImpl ?? (async () => undefined));
		const reportError = vi.fn();
		const fullGuild = {
			id: "guild-a",
			name: "Guild A",
			ownerId: "owner-1",
			channels: { cache: new Map() },
			members: { cache: new Map() },
		};
		const guild = {
			id: "guild-a",
			name: "Guild A",
			fetch: vi.fn(async () => fullGuild),
		};
		const runtime = {
			agentId: AGENT_ID,
			getSetting: vi.fn(() => undefined),
			reportError,
			emitEvent: vi.fn(async () => undefined),
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		};
		const service = {
			runtime,
			accountId: "default",
			slashCommands: opts.commands,
			client: { application: { commands: { set: guildScopeSet } } },
		};
		await handleGuildCreate(service as never, guild as never);
		return { guildScopeSet, reportError, runtime };
	}

	it("registers guild-only and targeted commands, never globals, on guild join", async () => {
		const { guildScopeSet, runtime } = await runGuildCreate({
			commands: [
				command("global"),
				command("guild-only", { guildOnly: true }),
				command("targeted", { guildIds: ["guild-a"] }),
			],
		});

		expect(guildScopeSet).toHaveBeenCalledWith(
			[
				expect.objectContaining({ name: "guild-only" }),
				expect.objectContaining({ name: "targeted" }),
			],
			"guild-a",
		);
		// Guild onboarding continued: the joined world is announced.
		expect(runtime.emitEvent).toHaveBeenCalled();
	});

	it("writes an empty guild scope on join to clear stale global copies", async () => {
		const { guildScopeSet } = await runGuildCreate({
			commands: [command("global")],
		});

		expect(guildScopeSet).toHaveBeenCalledWith([], "guild-a");
	});

	it("keeps a targeted command for another guild out of this guild's scope", async () => {
		const { guildScopeSet } = await runGuildCreate({
			commands: [command("elsewhere", { guildIds: ["guild-z"] })],
		});

		expect(guildScopeSet).toHaveBeenCalledWith([], "guild-a");
	});

	it("surfaces a failed join-sync via reportError and still finishes onboarding", async () => {
		const { reportError, runtime } = await runGuildCreate({
			commands: [command("guild-only", { guildOnly: true })],
			setImpl: async () => {
				throw new Error("50001: Missing Access");
			},
		});

		expect(reportError).toHaveBeenCalledWith(
			"DiscordService.guildCreateCommandSync",
			expect.any(Error),
			expect.objectContaining({ guildId: "guild-a" }),
		);
		// The world-joined events still fire — a failed command write does not
		// abort guild onboarding.
		expect(runtime.emitEvent).toHaveBeenCalled();
	});
});
