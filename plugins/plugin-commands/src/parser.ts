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
 * Check if text contains a command
 */
export function hasCommand(text: string): boolean {
	if (!text) return false;
	const trimmed = text.trim();
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

	const trimmed = text.trim();

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
		if (
			trimmed.toLowerCase().startsWith(`${normalized} `) ||
			trimmed.toLowerCase().startsWith(`${normalized}:`)
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

	return {
		key: definition.key,
		canonical: definition.textAliases[0] ?? `/${definition.key}`,
		args,
		rawArgs: rawArgs || undefined,
	};
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

	for (let i = 0; i < tokens.length; i++) {
		const argDef = argDefs[i];

		// If this arg captures remaining, join all remaining tokens
		if (argDef?.captureRemaining) {
			args.push(tokens.slice(i).join(" "));
			break;
		}

		args.push(tokens[i]);
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

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

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

	// Remove bot mention prefix (e.g., "@bot /status" -> "/status")
	if (botMention) {
		const mentionPattern = new RegExp(`^@${escapeRegExp(botMention)}\\s*`, "i");
		normalized = normalized.replace(mentionPattern, "");
	}

	// Handle colon in command (e.g., "/command: args" -> "/command args")
	normalized = normalized.replace(/^(\/\w+):\s*/, "$1 ");

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
