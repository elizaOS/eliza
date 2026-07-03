/**
 * Command system types
 */

import type {
	CommandArgSource,
	CommandCategory,
	CommandDefinition,
	CommandScope,
	CommandSurface,
	CommandTarget,
	HandlerCallback,
	Memory,
} from "@elizaos/core";

// The canonical command contract lives in @elizaos/core so hosts and other
// plugins can register/read commands through the runtime service without
// importing this plugin. Re-exported here for existing intra-package and
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
	CommandTarget,
} from "@elizaos/core";

/**
 * Wire-safe argument shape produced by `serializeCommand`. Mirrors the client
 * (`@elizaos/ui` `SlashCommandArg`) and TUI (`SerializedCommandArg`) transport
 * types so all three consume one shape with no fabricated fields.
 */
export interface SerializedCommandArg {
	name: string;
	description: string;
	required?: boolean;
	choices?: string[];
	dynamicChoices?: CommandArgSource;
	captureRemaining?: boolean;
}

/** Where a serialized catalog item came from — drives menu grouping/labels. */
export type SerializedCommandSource = "builtin" | "custom-action" | "saved";

/**
 * The canonical wire shape served by `GET /api/commands` and consumed by the
 * web composer (`SlashCommandCatalogItem`), the TUI autocomplete
 * (`SerializedCommand`), and the connector bridges. This is the single contract
 * the route projects — no field is fabricated at the HTTP boundary.
 */
export interface SerializedCommand {
	key: string;
	nativeName: string;
	description: string;
	textAliases: string[];
	scope: CommandScope;
	category?: CommandCategory;
	acceptsArgs: boolean;
	args: SerializedCommandArg[];
	requiresAuth: boolean;
	requiresElevated: boolean;
	surfaces?: CommandSurface[];
	target: CommandTarget;
	icon?: string;
	source: SerializedCommandSource;
	/** View ids this command is scoped to (#8798); omitted when global. */
	views?: string[];
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
