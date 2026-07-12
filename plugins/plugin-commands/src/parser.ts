/**
 * Command parser - detects and parses commands from message text
 */

import { startsWithCommand } from "./registry";
import type {
	CommandDefinition,
	CommandDetectionResult,
	ParsedCommand,
} from "./types";

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A leading bot mention followed by optional whitespace/newlines. Matches the
 * connector-native raw mention forms so command detection sees the same text
 * regardless of whether the server requires an explicit mention:
 *   - Discord user mention `<@123>` / `<@!123>` (the `!` is the legacy nickname form)
 *   - Discord role/channel-style angle mentions are intentionally NOT stripped
 *     (only user mentions prefix a command); a bare `@name` textual mention is
 *     handled separately by {@link normalizeCommandBody} with the known name.
 *
 * Only a SINGLE leading mention is stripped, and only when it sits at the very
 * start — so `/model <@123>` (a mention inside an argument) is untouched.
 */
const LEADING_RAW_MENTION = /^<@!?\d+>\s*/;

/**
 * Strip a leading connector-native bot mention (`<@id>` / `<@!id>`) plus the
 * whitespace/newline that separates it from the command, so a mention-prefixed
 * command (`<@bot> /model show`, common on strict-mention Discord servers)
 * matches the deterministic command layer exactly like a bare `/model show`.
 *
 * Text-form `@name` mentions are left to {@link normalizeCommandBody} (which
 * needs the bot's display name); this handles the id form every connector emits
 * in `content.text` before command detection runs, so no connector-specific
 * pre-normalization is required for the raw mention to be defeated.
 */
export function stripLeadingBotMention(text: string): string {
	return text.replace(LEADING_RAW_MENTION, "");
}

/**
 * Check if text contains a command
 */
export function hasCommand(text: string): boolean {
	if (!text) return false;
	const trimmed = stripLeadingBotMention(text.trim()).trim();
	if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) return false;
	return Boolean(startsWithCommand(trimmed));
}

/**
 * Detect command in text
 */
export function detectCommand(text: string): CommandDetectionResult {
	if (!text) {
		return { isCommand: false };
	}

	const trimmed = stripLeadingBotMention(text.trim()).trim();

	// Quick check for command prefix
	if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) {
		return { isCommand: false };
	}

	const command = startsWithCommand(trimmed);
	if (!command) {
		return { isCommand: false };
	}

	const parsed = parseCommand(trimmed, command);
	if (!parsed) {
		return { isCommand: false };
	}

	return { isCommand: true, command: parsed };
}

/**
 * Parse a command from text
 */
export function parseCommand(
	text: string,
	definition: CommandDefinition,
): ParsedCommand | null {
	const trimmed = text.trim();

	// Find the matching alias
	let matchedAlias: string | null = null;
	for (const alias of definition.textAliases) {
		const normalized = alias.toLowerCase();
		if (trimmed.toLowerCase() === normalized) {
			matchedAlias = alias;
			break;
		}
		const remainder = trimmed.slice(alias.length);
		if (
			trimmed.toLowerCase().startsWith(normalized) &&
			/^[\s:]/.test(remainder)
		) {
			matchedAlias = alias;
			break;
		}
	}

	if (!matchedAlias) {
		return null;
	}

	// Extract arguments
	let rawArgs = trimmed.slice(matchedAlias.length).trim();

	// Handle colon separator (e.g., /think:high)
	if (rawArgs.startsWith(":")) {
		rawArgs = rawArgs.slice(1).trim();
	}

	// Parse arguments
	const args = parseArgs(rawArgs, definition);

	const parsed: ParsedCommand = {
		key: definition.key,
		canonical: definition.textAliases[0] ?? `/${definition.key}`,
		args,
	};
	if (rawArgs) {
		parsed.rawArgs = rawArgs;
	}
	return parsed;
}

/**
 * Parse arguments based on command definition
 */
function parseArgs(rawArgs: string, definition: CommandDefinition): string[] {
	if (!rawArgs || !definition.acceptsArgs) {
		return [];
	}

	const parsing = definition.argsParsing ?? "positional";

	if (parsing === "none") {
		// Return entire string as single argument
		return rawArgs ? [rawArgs] : [];
	}

	// Positional parsing
	const args: string[] = [];
	const argDefs = definition.args ?? [];

	// Split by whitespace, respecting quotes
	const tokens = tokenize(rawArgs);

	for (const [i, token] of tokens.entries()) {
		const argDef = argDefs[i];

		// If this arg captures remaining, join all remaining tokens
		if (argDef?.captureRemaining) {
			args.push(tokens.slice(i).join(" "));
			break;
		}

		args.push(token);
	}

	return args;
}

/**
 * Tokenize argument string, respecting quotes
 */
function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;
	let quoteChar = "";

	for (const char of input) {
		if (inQuote) {
			if (char === quoteChar) {
				inQuote = false;
				if (current) {
					tokens.push(current);
					current = "";
				}
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = true;
			quoteChar = char;
		} else if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	if (current) {
		tokens.push(current);
	}

	return tokens;
}

/**
 * Normalize command body (handle bot mentions, colon syntax, etc.)
 */
export function normalizeCommandBody(
	text: string,
	botMention?: string,
): string {
	let normalized = text.trim();

	// Remove a leading connector-native mention (`<@id>` / `<@!id>`) first — the
	// id form every connector emits in content.text, independent of any known
	// display name.
	normalized = stripLeadingBotMention(normalized).trim();

	// Remove textual bot mention prefix (e.g., "@bot /status" -> "/status")
	if (botMention) {
		const mentionPattern = new RegExp(`^@${escapeRegExp(botMention)}\\s*`, "i");
		normalized = normalized.replace(mentionPattern, "");
	}

	// Handle colon in command (e.g., "/command: args" -> "/command args")
	normalized = normalized.replace(/^([/!][^\s:]+):\s*/, "$1 ");

	return normalized.trim();
}

/**
 * Check if text is a command-only message (no other content)
 */
export function isCommandOnly(text: string): boolean {
	const detection = detectCommand(text);
	if (!detection.isCommand || !detection.command) {
		return false;
	}

	// If there's no rawArgs, it's command-only
	if (!detection.command.rawArgs) {
		return true;
	}

	// Check if rawArgs is just whitespace
	return detection.command.rawArgs.trim().length === 0;
}

/**
 * Get command and remaining text
 */
export function extractCommand(
	text: string,
): { command: ParsedCommand; remainingText: string } | null {
	const detection = detectCommand(text);
	if (!detection.isCommand || !detection.command) {
		return null;
	}

	const { command } = detection;

	// For commands that don't accept args, remaining text is everything after the command
	if (!command.rawArgs) {
		return { command, remainingText: "" };
	}

	return { command, remainingText: command.rawArgs };
}
