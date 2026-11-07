/**
 * A failed global or guild-targeted slash-command sync must be surfaced
 * through `runtime.reportError`, not left as a log line only. The per-guild
 * fan-out in `slash-command-registration.ts` already reports its failures
 * (error-policy:J7), and the guild-join sync in `discord-commands.ts`
 * reports its own — but a failing global `commands.set()` (for example a
 * user-install rejection when the app is not portal-configured for user
 * install, the default) or a failing targeted command create/edit only
 * logged, while registration still resolved successfully and startup still
 * logged "Commands registered". The bot then looked healthy while its
 * DM/global commands, or a guild-pinned command, were silently absent.
 */
import { parseBooleanFromText } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	registerDiscordSlashCommands,
	type SlashCommandRegistrationHost,
} from "../slash-command-registration.ts";
import type { DiscordSlashCommand } from "../types.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

interface HarnessOptions {
	globalSet?: (commands: unknown[], guildId?: string) => Promise<unknown>;
	targetedCreate?: () => Promise<unknown>;
}

function harness(options: HarnessOptions = {}) {
	const reportError = vi.fn();
	const logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	const globalSet =
		options.globalSet ??
		(async () => {
			return undefined;
		});
	const targetedCreate =
		options.targetedCreate ??
		(async () => {
			return undefined;
		});
	const guilds = new Map<string, unknown>();
	const client = {
		isReady: () => true,
		application: {
			commands: {
				set: vi.fn(async (commands: unknown[], guildId?: string) => {
					// The per-guild fan-out passes a guild id; the global sync
					// passes none. Both go through the same fake endpoint.
					if (guildId !== undefined) {
						return undefined;
					}
					return globalSet(commands, guildId);
				}),
			},
		},
		guilds: { cache: guilds },
	};
	const host = {
		runtime: {
			agentId: AGENT_ID,
			getSetting: () => undefined,
			logger,
			reportError,
		},
		slashCommands: [] as DiscordSlashCommand[],
		allowAllSlashCommands: new Set<string>(),
		commandRegistrationQueue: Promise.resolve(),
		requireAccountState: () => ({
			accountId: "acct-1",
			client,
			clientReadyPromise: Promise.resolve(),
		}),
	};
	return {
		host: host as unknown as SlashCommandRegistrationHost,
		reportError,
		logger,
		guilds,
		targetedCreate,
	};
}

function targetedGuild(guildId: string, create: () => Promise<unknown>) {
	return {
		id: guildId,
		name: "Guild One",
		fetch: async () => ({
			commands: {
				// No existing command with this name, so registration takes
				// the create branch.
				fetch: async () => [],
				create,
			},
		}),
	};
}

describe("Discord slash-command registration failures", () => {
	it("reports a failing global command sync instead of only logging it", async () => {
		const { host, reportError, logger } = harness({
			globalSet: async () => {
				throw new Error("global boom");
			},
		});
		await registerDiscordSlashCommands(
			host,
			[{ name: "ping", description: "Ping" }],
			parseBooleanFromText,
		);
		expect(reportError).toHaveBeenCalledWith(
			"DiscordService.commandSync",
			expect.any(Error),
			expect.objectContaining({ accountId: "acct-1" }),
		);
		expect(logger.error).toHaveBeenCalled();
	});

	it("reports a failing guild-targeted command sync instead of only logging it", async () => {
		const create = vi.fn(async () => {
			throw new Error("target boom");
		});
		const { host, reportError, guilds } = harness();
		guilds.set("guild-1", targetedGuild("guild-1", create));
		await registerDiscordSlashCommands(
			host,
			[{ name: "pinned", description: "Pinned", guildIds: ["guild-1"] }],
			parseBooleanFromText,
		);
		expect(create).toHaveBeenCalledTimes(1);
		expect(reportError).toHaveBeenCalledWith(
			"DiscordService.commandSync",
			expect.any(Error),
			expect.objectContaining({
				accountId: "acct-1",
				guildId: "guild-1",
				commandName: "pinned",
			}),
		);
	});

	it("does not report when registration succeeds", async () => {
		const { host, reportError } = harness();
		await registerDiscordSlashCommands(
			host,
			[{ name: "ping", description: "Ping" }],
			parseBooleanFromText,
		);
		expect(reportError).not.toHaveBeenCalled();
	});
});
