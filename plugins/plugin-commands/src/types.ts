/**
 * Command system types
 */

import type { CommandDefinition, HandlerCallback, Memory } from "@elizaos/core";

// The canonical command contract — both the `CommandDefinition` shape and the
// wire-safe `Serialized*` transport types — lives in @elizaos/core so hosts and
// other plugins can register/read commands through the runtime service without
// importing this plugin, and every surface (web composer, TUI, connectors)
// consumes one definition. Re-exported here for existing intra-package and
// downstream `@elizaos/plugin-commands` consumers.
export type {
	ClientCommandAction,
	CommandArgChoiceContext,
	CommandArgDefinition,
	CommandArgSource,
	CommandCategory,
	CommandDefinition,
	CommandScope,
	CommandSurface,
	CommandsCatalogResponse,
	CommandTarget,
	SerializedCommand,
	SerializedCommandArg,
	SerializedCommandSource,
} from "@elizaos/core";

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
