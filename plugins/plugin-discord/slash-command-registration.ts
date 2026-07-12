/**
 * Slash-command registration for `DiscordService.registerSlashCommands`.
 * Merges an incoming command batch into the service's running set, then
 * pushes the result to Discord: globally (for DMs), per-guild (for instant
 * availability), and per-target-guild for commands pinned to specific guild
 * IDs. Extracted out of `service.ts` so this logic — and the
 * `DISCORD_USER_INSTALL` opt-in this file threads through every
 * `transformCommandToDiscordApi` call — has a coverage surface independent of
 * the surrounding god-class (#16067).
 *
 * `host` is the subset of `DiscordService` this needs: the mutable
 * command/queue state plus a logger and error reporter. Passing it explicitly
 * (rather than importing `DiscordService`) keeps this file free of the
 * service's account-lifecycle and Discord-client wiring, and lets tests
 * construct a minimal fake instead of the full service.
 */
import type { IAgentRuntime, parseBooleanFromText } from "@elizaos/core";
import type { DiscordAccountClientState } from "./account-client-pool";
import {
	isGuildOnlyCommand,
	transformCommandToDiscordApi,
} from "./discord-commands";
import type { DiscordSlashCommand } from "./types";

export interface SlashCommandRegistrationHost {
	runtime: IAgentRuntime;
	slashCommands: DiscordSlashCommand[];
	allowAllSlashCommands: Set<string>;
	commandRegistrationQueue: Promise<void>;
	requireAccountState(accountId?: string | null): DiscordAccountClientState;
}

export async function registerDiscordSlashCommands(
	host: SlashCommandRegistrationHost,
	commands: DiscordSlashCommand[],
	parseBooleanFromTextFn: typeof parseBooleanFromText,
	accountId?: string | null,
): Promise<void> {
	const state = host.requireAccountState(accountId);
	await state.clientReadyPromise;

	const client = state.client;
	const clientApplication = client?.application;
	if (!clientApplication) {
		host.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: host.runtime.agentId,
				accountId: state.accountId,
			},
			"Cannot register commands - Discord client application not available",
		);
		return;
	}

	if (!Array.isArray(commands) || commands.length === 0) {
		host.runtime.logger.warn(
			{
				src: "plugin:discord",
				agentId: host.runtime.agentId,
				accountId: state.accountId,
			},
			"Cannot register commands - no commands provided",
		);
		return;
	}

	for (const cmd of commands) {
		if (!cmd.name || !cmd.description) {
			host.runtime.logger.warn(
				{
					src: "plugin:discord",
					agentId: host.runtime.agentId,
					accountId: state.accountId,
				},
				"Cannot register commands - invalid command (missing name or description)",
			);
			return;
		}
	}

	let registrationError: Error | null = null;
	let registrationFailed = false;

	// Opt into user-installable / group-DM command availability. Off by
	// default: Discord rejects user-install command registration unless the
	// app is configured as user-installable in the developer portal.
	const userInstall = parseBooleanFromTextFn(
		String(host.runtime.getSetting("DISCORD_USER_INSTALL") ?? ""),
	);

	host.commandRegistrationQueue = host.commandRegistrationQueue
		.then(async () => {
			const commandMap = new Map<string, DiscordSlashCommand>();
			for (const cmd of host.slashCommands) {
				if (cmd.name) commandMap.set(cmd.name, cmd);
			}
			for (const cmd of commands) {
				if (cmd.name) commandMap.set(cmd.name, cmd);
			}
			host.slashCommands = Array.from(commandMap.values());

			host.allowAllSlashCommands.clear();
			for (const cmd of host.slashCommands) {
				if (cmd.bypassChannelWhitelist) {
					host.allowAllSlashCommands.add(cmd.name);
				}
			}

			const generalCommands = host.slashCommands.filter(
				(cmd) => (cmd.guildIds?.length ?? 0) === 0,
			);
			const globalCommands = generalCommands.filter(
				(cmd) => !isGuildOnlyCommand(cmd),
			);
			const guildOnlyCommands = generalCommands.filter((cmd) =>
				isGuildOnlyCommand(cmd),
			);
			const targetedGuildCommands = host.slashCommands.filter(
				(cmd) => cmd.guildIds && cmd.guildIds.length > 0,
			);

			const transformedGlobalCommands = globalCommands.map((cmd) =>
				transformCommandToDiscordApi(cmd, { userInstall }),
			);
			const transformedGuildOnlyCommands = guildOnlyCommands.map((cmd) =>
				transformCommandToDiscordApi(cmd, { userInstall }),
			);

			const clientApp = client.application;
			if (!clientApp) {
				throw new Error("Discord client application is not available");
			}

			try {
				await clientApp.commands.set(transformedGlobalCommands);
			} catch (err) {
				host.runtime.logger.error(
					{
						src: "plugin:discord",
						agentId: host.runtime.agentId,
						accountId: state.accountId,
						error: err instanceof Error ? err.message : String(err),
					},
					"Failed to register/clear global commands",
				);
			}

			// Per-guild registration pushes ONLY the guild-only commands: global
			// commands live in the global scope, and Discord renders a command
			// present in BOTH scopes twice in the slash menu. Setting the
			// guild-only set (often empty) also clears any stale guild-scoped
			// copies of global commands, which is what removes existing
			// duplicates.
			const guilds = client.guilds.cache;
			if (guilds) {
				await Promise.all(
					[...guilds].map(async ([guildId, guild]) => {
						try {
							await clientApp.commands.set(
								transformedGuildOnlyCommands,
								guildId,
							);
						} catch (err) {
							// error-policy:J7 one guild's failed command write must not
							// abort the sync fan-out to the remaining guilds; the partial
							// sync is surfaced to the agent/owner via reportError rather
							// than left as a healthy-looking startup.
							host.runtime.reportError(
								"DiscordService.commandSync",
								err instanceof Error ? err : new Error(String(err)),
								{
									accountId: state.accountId,
									guildId,
									guildName: guild.name,
								},
							);
							host.runtime.logger.warn(
								{
									src: "plugin:discord",
									agentId: host.runtime.agentId,
									accountId: state.accountId,
									guildId,
									guildName: guild.name,
									error: err instanceof Error ? err.message : String(err),
								},
								"Failed to register commands to guild",
							);
						}
					}),
				);
			}

			if (guilds && targetedGuildCommands.length > 0) {
				await Promise.all(
					targetedGuildCommands.flatMap((cmd) => {
						const transformedCmd = transformCommandToDiscordApi(cmd, {
							userInstall,
							guildScoped: true,
						});
						return (cmd.guildIds ?? []).map(async (guildId) => {
							const guild = guilds.get(guildId);
							if (!guild) return;
							try {
								const fullGuild = await guild.fetch();
								const existingCommands = await fullGuild.commands.fetch();
								const existingCommand = existingCommands.find(
									(c) => c.name === cmd.name,
								);
								if (existingCommand) {
									await existingCommand.edit(
										transformedCmd as Partial<
											import("discord.js").ApplicationCommandData
										>,
									);
								} else {
									await fullGuild.commands.create(transformedCmd);
								}
							} catch (error) {
								host.runtime.logger.error(
									{
										src: "plugin:discord",
										agentId: host.runtime.agentId,
										accountId: state.accountId,
										commandName: cmd.name,
										guildId,
										error:
											error instanceof Error ? error.message : String(error),
									},
									"Failed to register targeted command in guild",
								);
							}
						});
					}),
				);
			}

			host.runtime.logger.info(
				{
					src: "plugin:discord",
					agentId: host.runtime.agentId,
					accountId: state.accountId,
					newCommands: commands.length,
					totalCommands: host.slashCommands.length,
				},
				"Commands registered",
			);
		})
		.catch((error) => {
			registrationFailed = true;
			registrationError =
				error instanceof Error ? error : new Error(String(error));
			host.runtime.logger.error(
				{
					src: "plugin:discord",
					agentId: host.runtime.agentId,
					accountId: state.accountId,
					error: registrationError.message,
				},
				"Error registering Discord commands",
			);
		});

	await host.commandRegistrationQueue;

	if (registrationFailed && registrationError) {
		throw registrationError;
	}
}
