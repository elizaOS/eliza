/**
 * Command system types
 */

import type { CommandDefinition, HandlerCallback, Memory } from "@elizaos/core";

// The canonical command *definition* contract lives in @elizaos/core so hosts
// and other plugins can register/read commands through the runtime service
// without importing this plugin. Re-exported here for existing intra-package
// and downstream `@elizaos/plugin-commands` consumers.
export type {
	ClientCommandAction,
	CommandArgChoiceContext,
	CommandArgDefinition,
	CommandArgSource,
	CommandCategory,
	CommandDefinition,
	CommandScope,
	CommandSurface,
	CommandTarget,
} from "@elizaos/core";

// The wire transport contract (`SerializedCommand*`) is declared once in
// @elizaos/shared and consumed by the UI client and connector bridges, so no
// hand-synced copy can drift (#12411). Re-exported
// here so `serializeCommand` and downstream plugin consumers keep one import.
export type {
	SerializedCommand,
	SerializedCommandArg,
	SerializedCommandSource,
} from "@elizaos/shared";

export interface CommandContext {
	senderId?: string;
	senderName?: string;
	isAuthorized: boolean;
	isElevated: boolean;
	channelId?: string;
	roomId: string;
	accountId?: string;
	config?: Record<string, unknown>;
	message?: Memory;
	callback?: HandlerCallback;
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
