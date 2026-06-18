/**
 * Universal slash-command catalog → Discord native commands.
 *
 * Maps the connector-neutral command catalog from `@elizaos/plugin-commands`
 * (`getConnectorCommands("discord")`) onto the plugin's in-process
 * `SlashCommand` registry so the catalog's navigation + agent-capability
 * commands appear alongside the hand-written Discord built-ins.
 *
 * Dedupe decision: the existing Discord built-ins (`help`, `status`, `model`,
 * `settings`, `search`, `clear`, `setup`) already have working, role-gated
 * handlers (some with autocomplete and Discord-specific behavior). To PRESERVE
 * all existing behavior we register only the catalog commands whose sanitized
 * name does NOT already exist in the registry — built-ins always win. This adds
 * the new catalog commands (think, reasoning, views, orchestrator, knowledge,
 * plugins, …) without touching the tested built-in command surface.
 *
 * Per-target dispatch:
 *   - `agent`    → route the reconstructed command text (e.g. `/think high`)
 *                  through the runtime's message pipeline and reply with the
 *                  agent's answer.
 *   - `navigate` → reply (ephemeral) describing the destination, resolving the
 *                  `/settings <section>` argument when present.
 *   - `client`   → GUI/TUI-only behaviors are filtered out of the discord
 *                  surface upstream; handled defensively with a short reply.
 */

import type { Content, HandlerCallback, Memory, UUID } from "@elizaos/core";
import { createUniqueUuid, type IAgentRuntime } from "@elizaos/core";
import {
	type ConnectorCommand,
	getConnectorCommands,
	resolveSettingsSection,
} from "@elizaos/plugin-commands";
import type { ChatInputCommandInteraction } from "discord.js";
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
	commandText: string,
): Promise<void> {
	await safeInteractionCall(() => interaction.deferReply({ ephemeral: true }));

	const entityId = createUniqueUuid(runtime, interaction.user.id) as UUID;
	const roomId = createUniqueUuid(
		runtime,
		interaction.channelId || interaction.user.id,
	) as UUID;

	const message: Memory = {
		id: createUniqueUuid(runtime, `${interaction.id}-cmd`) as UUID,
		entityId,
		agentId: runtime.agentId,
		roomId,
		content: {
			text: commandText,
			source: "discord",
		},
		createdAt: Date.now(),
	};

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

/**
 * Build the `execute` handler for a catalog command, branching on its target.
 */
function buildExecute(command: ConnectorCommand): SlashCommand["execute"] {
	const target = command.target;

	if (target.kind === "navigate") {
		return async (interaction) => {
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
		};
	}

	if (target.kind === "client") {
		// GUI/TUI-only behaviors are filtered out of the discord surface, so this
		// branch should not be reached. Handle defensively rather than crash.
		return async (interaction) => {
			await safeInteractionCall(() =>
				interaction.reply({
					content: `\`/${command.name}\` is only available in the Eliza app.`,
					ephemeral: true,
				}),
			);
		};
	}

	// target.kind === "agent"
	return async (interaction, runtime) => {
		const commandText = buildCommandText(interaction, command);
		await routeCommandToAgent(interaction, runtime, commandText);
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
	return {
		name: command.name,
		description: command.description,
		...(options.length > 0 ? { options } : {}),
		execute: buildExecute(command),
	};
}

/**
 * Build the catalog commands for the Discord surface, deduped against an
 * existing set of command names (built-ins win). Pure — no side effects.
 */
export function buildCatalogSlashCommands(
	existingNames: ReadonlySet<string> = new Set(),
): SlashCommand[] {
	const out: SlashCommand[] = [];
	const seen = new Set<string>(existingNames);
	for (const command of getConnectorCommands("discord")) {
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
	const commands = buildCatalogSlashCommands(existingNames);
	for (const command of commands) {
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
