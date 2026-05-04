/**
 * Command system types
 */

import type { Memory } from "@elizaos/core";

export type CommandScope = "text" | "native" | "both";
export type CommandCategory =
	| "session"
	| "options"
	| "status"
	| "management"
	| "media"
	| "tools"
	| "docks";

export interface CommandArgDefinition {
	name: string;
	description: string;
	required?: boolean;
	choices?: string[] | ((ctx: CommandArgChoiceContext) => string[]);
	captureRemaining?: boolean;
}

export interface CommandArgChoiceContext {
	provider?: string;
	model?: string;
	config?: Record<string, unknown>;
}

export interface CommandDefinition {
	key: string;
	nativeName?: string;
	description: string;
	textAliases: string[];
	scope: CommandScope;
	category?: CommandCategory;
	acceptsArgs?: boolean;
	args?: CommandArgDefinition[];
	argsParsing?: "none" | "positional";
	requiresAuth?: boolean;
	requiresElevated?: boolean;
	enabled?: boolean;
}

export interface CommandContext {
	senderId?: string;
	senderName?: string;
	isAuthorized: boolean;
	isElevated: boolean;
	channelId?: string;
	roomId: string;
	accountId?: string;
	config?: Record<string, unknown>;
}

export interface CommandResult {
	handled: boolean;
	reply?: string;
	shouldContinue: boolean;
	error?: string;
}

export interface ParsedCommand {
	key: string;
	canonical: string;
	args: string[];
	rawArgs?: string;
}

export interface CommandDetectionResult {
	isCommand: boolean;
	command?: ParsedCommand;
}

/**
 * Resolved command with full context
 */
export interface ResolvedCommand {
	definition: CommandDefinition;
	parsed: ParsedCommand;
	context: CommandContext;
	message: Memory;
}
