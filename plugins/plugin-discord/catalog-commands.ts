/**
 * Universal slash-command catalog → Discord native commands.
 *
 * Maps the connector-neutral command catalog from `@elizaos/plugin-commands`
 * (`getConnectorCommands("discord")`) onto the plugin's in-process
 * `SlashCommand` registry so the catalog's navigation + agent-capability
 * commands appear alongside the hand-written Discord built-ins.
 *
 * This is Discord's implementation of the shared `ConnectorCommandBridge`
 * contract (#8790): the same register/dispatch shape and the same auth-gating
 * decision Telegram uses, so both connectors behave consistently.
 *
 * Dedupe decision: the existing Discord built-ins (`help`, `status`, `model`,
 * `settings`, `search`, `clear`, `setup`) already have working, role-gated
 * handlers (some with autocomplete and Discord-specific behavior). To PRESERVE
 * all existing behavior we register only the catalog commands whose sanitized
 * name does NOT already exist in the registry — built-ins always win. This adds
 * the new catalog agent commands (think, reasoning, models, usage, queue, …)
 * without touching the tested built-in command surface. Navigation commands
 * never reach this bridge: they are app-surface-only (`surfaces` in
 * `navigation-commands.ts`) because navigating needs a viewport a chat
 * connector doesn't have.
 *
 * Per-target dispatch:
 *   - `agent`    → deterministic commands
 *                  (help/status/think/model/reset/…) resolve to a local reply
 *                  via `resolveCommand`; pipeline-owned agent commands route
 *                  the reconstructed command text through the runtime's message
 *                  pipeline and reply with the agent's answer.
 *   - `navigate` → filtered off connector surfaces upstream; handled
 *                  defensively with an ephemeral destination description,
 *                  resolving the `/settings <section>` argument when present.
 *   - `client`   → local-client behaviors are filtered out of the discord
 *                  surface upstream; handled defensively with a short reply.
 *
 * Auth gating: `requiresAuth` / `requiresElevated` commands are gated at the
 * connector boundary using the agent's role model (`hasRoleAccess`) — the same
 * mechanism the built-in slash commands use. The Discord sender is mapped to a
 * runtime entity, and a command is refused with a clear reply when the sender
 * is not an owner (for `requiresAuth`) or admin (for `requiresElevated`).
 */

import type { Content, HandlerCallback, Memory, UUID } from "@elizaos/core";
import {
	createUniqueUuid,
	hasRoleAccess,
	type IAgentRuntime,
} from "@elizaos/core";
import {
	type ConnectorCommand,
	type ConnectorSenderAuth,
	gateConnectorCommandByName,
	getConnectorCommands,
	resolveCommand,
	resolveSettingsSection,
} from "@elizaos/plugin-commands";
import type { ChatInputCommandInteraction } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import { safeInteractionCall } from "./native-commands";
import {
	addCommand,
	getRegisteredCommands,
	type SlashCommand,
	type SlashCommandOption,
} from "./slash-commands";
import { getMessageService, getMessagingAPI } from "./utils";

/** How long to wait for the agent to produce a reply before giving up. */
const AGENT_REPLY_TIMEOUT_MS = 60_000;

/** The catalog surface this bridge serves. */
const DISCORD_SURFACE = "discord";
const DISCORD_EMBED_COMMAND = "app";

/**
 * Map a Discord interaction onto the runtime entity / room the rest of the
 * pipeline uses, so the same identity drives both role resolution and the
 * routed message.
 */
function interactionEntityId(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
): UUID {
	return createUniqueUuid(runtime, interaction.user.id) as UUID;
}

function interactionRoomId(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
): UUID {
	return createUniqueUuid(
		runtime,
		interaction.channelId || interaction.user.id,
	) as UUID;
}

/**
 * Build the connector-neutral `Memory` used both for role resolution and (for
 * agent commands) routing into the pipeline.
 */
function buildCommandMemory(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
	commandText: string,
): Memory {
	return {
		id: createUniqueUuid(runtime, `${interaction.id}-cmd`) as UUID,
		entityId: interactionEntityId(interaction, runtime),
		agentId: runtime.agentId,
		roomId: interactionRoomId(interaction, runtime),
		content: { text: commandText, source: DISCORD_SURFACE },
		createdAt: Date.now(),
	};
}

/**
 * Resolve the Discord sender's trust level using the agent's role model — the
 * same `hasRoleAccess` check the built-in slash commands run. OWNER access
 * satisfies `requiresAuth`; ADMIN access satisfies `requiresElevated`. Role
 * resolution maps the Discord user id through `createUniqueUuid` and reads the
 * canonical-owner / connector-admin whitelist the Discord service populates.
 */
export async function resolveDiscordSenderAuth(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
): Promise<ConnectorSenderAuth> {
	const memory = buildCommandMemory(interaction, runtime, "/whoami");
	const [isOwner, isAdmin] = await Promise.all([
		hasRoleAccess(runtime, memory, "OWNER"),
		hasRoleAccess(runtime, memory, "ADMIN"),
	]);
	return {
		isAuthorized: isOwner,
		isElevated: isAdmin,
		senderName: interaction.user.username,
	};
}

export function resolveDiscordEmbedUrl(runtime: IAgentRuntime): string | null {
	const configured = [
		runtime.getSetting?.("DISCORD_EMBED_URL"),
		runtime.getSetting?.("ELIZA_EMBED_URL"),
		process.env.DISCORD_EMBED_URL,
		process.env.ELIZA_EMBED_URL,
		process.env.ELIZA_APP_URL,
	].find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
	if (!configured) return null;
	try {
		const url = new URL(configured.trim());
		if (url.protocol !== "https:") return null;
		if (url.pathname === "/" || url.pathname === "") url.pathname = "/embed";
		url.searchParams.set("platform", "discord");
		return url.toString();
	} catch {
		return null;
	}
}

export function buildDiscordEmbedCommand(): SlashCommand {
	return {
		name: DISCORD_EMBED_COMMAND,
		description: "Open the Eliza app from Discord.",
		execute: async (interaction, runtime) => {
			const sender = await resolveDiscordSenderAuth(interaction, runtime);
			if (!sender.isAuthorized && !sender.isElevated) {
				await safeInteractionCall(() =>
					interaction.reply({
						content:
							"Opening the Eliza app from Discord requires OWNER or ADMIN access.",
						ephemeral: true,
					}),
				);
				return;
			}

			const embedUrl = resolveDiscordEmbedUrl(runtime);
			if (!embedUrl) {
				await safeInteractionCall(() =>
					interaction.reply({
						content: "The Eliza embedded app URL is not configured.",
						ephemeral: true,
					}),
				);
				return;
			}

			await safeInteractionCall(() =>
				interaction.reply({
					content: `Open the Eliza app: ${embedUrl}`,
					ephemeral: true,
				}),
			);
		},
	};
}

/**
 * Reconstruct the text form of a slash command from the interaction so it can
 * be routed into the agent (e.g. `/think high`, `/model gpt-5`). Option values
 * are appended in declaration order as positional arguments, matching how the
 * universal catalog parses connector command arguments.
 */
function buildCommandText(
	interaction: ChatInputCommandInteraction,
	command: ConnectorCommand,
): string {
	const parts = [`/${command.name}`];
	for (const option of command.options) {
		const value = readStringOption(interaction, option.name);
		if (value) parts.push(value);
	}
	return parts.join(" ");
}

function readStringOption(
	interaction: ChatInputCommandInteraction,
	name: string,
): string | undefined {
	const value = interaction.options.getString(name);
	return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Route a reconstructed command into the agent's message pipeline and surface
 * the reply on the interaction. Reuses the same `messageService` /
 * `elizaOS` message API the inbound Discord message handler uses, so the
 * command flows through the agent's normal action/command handling.
 */
async function routeCommandToAgent(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
	message: Memory,
): Promise<void> {
	await safeInteractionCall(() => interaction.deferReply({ ephemeral: true }));

	const commandText = message.content.text ?? "";

	let replied = "";
	const callback: HandlerCallback = async (content: Content) => {
		if (typeof content.text === "string" && content.text.trim().length > 0) {
			replied = replied ? `${replied}\n${content.text}` : content.text;
		}
		return [];
	};

	const messageService = getMessageService(runtime);
	const messagingAPI = getMessagingAPI(runtime);

	const dispatch = async (): Promise<void> => {
		if (messageService) {
			await messageService.handleMessage(runtime, message, callback);
		} else if (messagingAPI?.handleMessage) {
			await messagingAPI.handleMessage(runtime.agentId, message, {
				onResponse: callback,
			});
		} else if (messagingAPI?.sendMessage) {
			await messagingAPI.sendMessage(runtime.agentId, message, {
				onResponse: callback,
			});
		} else {
			throw new Error("no message routing API available");
		}
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("agent reply timed out")),
			AGENT_REPLY_TIMEOUT_MS,
		);
	});

	try {
		await Promise.race([dispatch(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}

	const content =
		replied.trim().length > 0
			? replied.slice(0, 1900)
			: `Ran \`${commandText}\`.`;
	await safeInteractionCall(() => interaction.editReply({ content }));
}

/**
 * Run an agent-target command. Deterministic commands
 * (help/status/think/model/reset/…) are resolved via `resolveCommand` and
 * answered locally. Pipeline-owned commands fall back to routing the
 * reconstructed command text through the agent.
 */
async function dispatchAgentCommand(
	interaction: ChatInputCommandInteraction,
	runtime: IAgentRuntime,
	command: ConnectorCommand,
	sender: ConnectorSenderAuth,
): Promise<void> {
	const commandText = buildCommandText(interaction, command);
	const message = buildCommandMemory(interaction, runtime, commandText);

	const resolved = await resolveCommand(runtime, message, {
		isAuthorized: sender.isAuthorized,
		isElevated: sender.isElevated,
		...(sender.senderName ? { senderName: sender.senderName } : {}),
	});
	if (resolved.handled && resolved.reply !== undefined) {
		await safeInteractionCall(() =>
			interaction.reply({
				content: resolved.reply?.slice(0, 1900) ?? "",
				ephemeral: true,
			}),
		);
		return;
	}

	await routeCommandToAgent(interaction, runtime, message);
}

/** Human-readable destination string for a navigation target. */
function describeNavigation(
	command: ConnectorCommand,
	sectionLabel?: string,
): string {
	const target = command.target;
	if (target.kind !== "navigate") return `Open ${command.name}.`;

	const place = sectionLabel
		? `${command.name} → ${sectionLabel}`
		: command.name;
	const deepLink = target.path ? ` (\`${target.path}\`)` : "";
	return `Open **${place}** in the Eliza app${deepLink}.`;
}

async function dispatchNavigateCommand(
	interaction: ChatInputCommandInteraction,
	command: ConnectorCommand,
): Promise<void> {
	let sectionLabel: string | undefined;
	if (command.name === "settings") {
		const raw = readStringOption(interaction, "section");
		if (raw) sectionLabel = resolveSettingsSection(raw) ?? raw;
	}
	await safeInteractionCall(() =>
		interaction.reply({
			content: describeNavigation(command, sectionLabel),
			ephemeral: true,
		}),
	);
}

async function dispatchClientCommand(
	interaction: ChatInputCommandInteraction,
	command: ConnectorCommand,
): Promise<void> {
	// Local-client behaviors are filtered out of the discord surface, so this
	// branch should not be reached. Handle defensively rather than crash.
	await safeInteractionCall(() =>
		interaction.reply({
			content: `\`/${command.name}\` is only available in the Eliza app.`,
			ephemeral: true,
		}),
	);
}

/**
 * Build the `execute` handler for a catalog command. Resolves the sender's
 * trust level, gates `requiresAuth` / `requiresElevated` commands (refusing
 * with a clear reply when the sender lacks access), then dispatches by target
 * kind.
 */
function buildExecute(command: ConnectorCommand): SlashCommand["execute"] {
	return async (interaction, runtime) => {
		const sender = await resolveDiscordSenderAuth(interaction, runtime);
		const gate = gateConnectorCommandByName(
			runtime.agentId,
			command.name,
			sender,
		);
		if (!gate.allowed) {
			await safeInteractionCall(() =>
				interaction.reply({ content: gate.reply, ephemeral: true }),
			);
			return;
		}

		const target = command.target;
		if (target.kind === "navigate") {
			await dispatchNavigateCommand(interaction, command);
			return;
		}
		if (target.kind === "client") {
			await dispatchClientCommand(interaction, command);
			return;
		}
		await dispatchAgentCommand(interaction, runtime, command, sender);
	};
}

/** Map a catalog option onto the plugin's `SlashCommandOption` shape. */
function mapOption(
	option: ConnectorCommand["options"][number],
): SlashCommandOption {
	const choices =
		option.choices.length > 0
			? option.choices
					.slice(0, 25)
					.map((value) => ({ name: value.slice(0, 100), value }))
			: undefined;
	return {
		name: option.name,
		description: option.description,
		type: "string",
		required: option.required,
		...(choices ? { choices } : {}),
	};
}

/** Map one catalog command onto an in-process `SlashCommand`. */
export function mapCatalogCommand(command: ConnectorCommand): SlashCommand {
	const options = command.options.map(mapOption);
	// Gate the NATIVE picker on the catalog's auth flags (the #16154 deferral):
	// elevated commands register admin-only, auth-required ones ManageGuild.
	// Discord's default_member_permissions only hides them in guild pickers —
	// server-side trust still re-checks on every execution (runCommand), and
	// paired DM users are unaffected (member permissions are guild-scoped).
	const requiredPermissions = command.requiresElevated
		? PermissionFlagsBits.Administrator
		: command.requiresAuth
			? PermissionFlagsBits.ManageGuild
			: undefined;
	return {
		name: command.name,
		description: command.description,
		...(options.length > 0 ? { options } : {}),
		...(requiredPermissions !== undefined ? { requiredPermissions } : {}),
		execute: buildExecute(command),
	};
}

/**
 * Build the catalog commands for the Discord surface, deduped against an
 * existing set of command names (built-ins win). Pure — no side effects.
 */
export function buildCatalogSlashCommands(
	existingNames: ReadonlySet<string> = new Set(),
	agentId?: string | null,
): SlashCommand[] {
	const out: SlashCommand[] = [];
	const seen = new Set<string>(existingNames);
	for (const command of getConnectorCommands(DISCORD_SURFACE, { agentId })) {
		if (seen.has(command.name)) continue;
		seen.add(command.name);
		out.push(mapCatalogCommand(command));
	}
	return out;
}

/**
 * Register the universal catalog commands into the in-process registry and
 * return them. Names already present (built-ins) are skipped so existing
 * behavior is preserved. Called from `onReady` right after the built-ins are
 * registered; the returned commands are folded into the
 * `DISCORD_REGISTER_COMMANDS` payload by `registerSlashCommands`.
 */
export function registerCatalogSlashCommands(
	runtime: IAgentRuntime,
): SlashCommand[] {
	const existingNames = new Set(getRegisteredCommands().keys());
	const commands = buildCatalogSlashCommands(existingNames, runtime.agentId);
	if (!existingNames.has(DISCORD_EMBED_COMMAND)) {
		const embedCommand = buildDiscordEmbedCommand();
		addCommand(embedCommand);
		commands.unshift(embedCommand);
	}
	for (const command of commands) {
		if (command.name === DISCORD_EMBED_COMMAND) continue;
		addCommand(command);
	}
	runtime.logger.info(
		{
			src: "catalog-commands",
			count: commands.length,
			names: commands.map((c) => c.name),
		},
		"Registering catalog slash commands",
	);
	return commands;
}
