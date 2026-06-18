/**
 * Map the universal command catalog onto chat connectors (Discord, Telegram).
 *
 * Produces a connector-neutral descriptor each connector adapts to its native
 * command API: Discord application commands (`name`/`description`/`options`),
 * Telegram `setMyCommands` (`command`/`description`). The descriptor carries the
 * `target` so a connector's handler knows whether to route the command to the
 * agent, reply with a deep link (navigation), or run a client behavior.
 */

import { getCommandsForSurface, serializeCommand } from "./registry";
import type { CommandSurface, CommandTarget } from "./types";

export type ConnectorSurface = Extract<CommandSurface, "discord" | "telegram">;

export interface ConnectorCommandOption {
	name: string;
	description: string;
	required: boolean;
	/** Up to 25 choices (Discord's option-choice cap). */
	choices: string[];
}

export interface ConnectorCommand {
	/** Stable catalog key (for de-dup + correlation). */
	key: string;
	/** Native command name, sanitized for the surface. */
	name: string;
	/** Description, clamped to the connector limit (100 chars). */
	description: string;
	options: ConnectorCommandOption[];
	target: CommandTarget;
}

const DISCORD_NAME_INVALID = /[^a-z0-9_-]/g;
const TELEGRAM_NAME_INVALID = /[^a-z0-9_]/g;
const MAX_DESCRIPTION = 100;
const MAX_NAME = 32;
const MAX_OPTION_CHOICES = 25;

/**
 * Sanitize a command/option name for a surface. Discord allows `[a-z0-9_-]`;
 * Telegram allows only `[a-z0-9_]` (hyphens become underscores).
 */
export function sanitizeConnectorName(
	raw: string,
	surface: ConnectorSurface,
): string {
	const lowered = raw.trim().toLowerCase();
	const cleaned =
		surface === "telegram"
			? lowered.replace(/-/g, "_").replace(TELEGRAM_NAME_INVALID, "")
			: lowered.replace(DISCORD_NAME_INVALID, "");
	return cleaned.slice(0, MAX_NAME);
}

function clampDescription(description: string): string {
	const trimmed = description.trim();
	if (trimmed.length <= MAX_DESCRIPTION) return trimmed || "—";
	return `${trimmed.slice(0, MAX_DESCRIPTION - 1)}…`;
}

/**
 * The catalog's enabled commands for a connector surface, mapped to native
 * descriptors and de-duplicated by sanitized name (first definition wins).
 */
export function getConnectorCommands(
	surface: ConnectorSurface,
): ConnectorCommand[] {
	const seen = new Set<string>();
	const out: ConnectorCommand[] = [];
	for (const command of getCommandsForSurface(surface)) {
		const serialized = serializeCommand(command);
		const name = sanitizeConnectorName(serialized.nativeName, surface);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push({
			key: serialized.key,
			name,
			description: clampDescription(serialized.description),
			options: serialized.args.map((arg) => ({
				name: sanitizeConnectorName(arg.name, surface),
				description: clampDescription(arg.description),
				required: arg.required ?? false,
				choices: (arg.choices ?? []).slice(0, MAX_OPTION_CHOICES),
			})),
			target: serialized.target,
		});
	}
	return out;
}

/**
 * Telegram `setMyCommands` payload: `{ command, description }[]`. Telegram has
 * no per-command options, so arguments are folded into the description hint.
 */
export function getTelegramBotCommands(): Array<{
	command: string;
	description: string;
}> {
	return getConnectorCommands("telegram").map((c) => {
		const argHint = c.options.length
			? ` <${c.options.map((o) => o.name).join("> <")}>`
			: "";
		return {
			command: c.name,
			description: clampDescription(`${c.description}${argHint}`),
		};
	});
}
