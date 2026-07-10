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
});
