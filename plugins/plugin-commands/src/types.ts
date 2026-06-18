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
	| "docks"
	| "skills"
	| "navigation";

/**
 * The client surfaces a command can appear on. A command with no `surfaces`
 * is available everywhere. `gui` = the web/desktop dashboard chat, `tui` =
 * the terminal UI, `discord`/`telegram` = the respective connectors.
 */
export type CommandSurface = "gui" | "tui" | "discord" | "telegram";

/**
 * A pure-client behavior triggered by a command (no agent round-trip). The
 * presentation layer maps each id to a concrete action; surfaces that don't
 * implement an action simply ignore it.
 */
export type ClientCommandAction =
	| "clear-chat"
	| "new-conversation"
	| "toggle-fullscreen"
	| "open-command-palette"
	| "show-commands";

/**
 * Navigate to an in-app view (and optionally a sub-section). The fields are
 * declarative navigation *hints* interpreted per surface: GUI surfaces select
 * the tab/section, the TUI navigates the view registry, and chat connectors
 * fall back to a deep link built from `path`. Values are stable, public route
 * identifiers (e.g. tab `settings`, section `ai-model`).
 */
export interface CommandNavigateTarget {
	kind: "navigate";
	/** App tab id for GUI surfaces (e.g. `settings`, `plugins`, `chat`). */
	tab?: string;
	/** View id in the runtime view registry (e.g. `orchestrator`). */
	viewId?: string;
	/** Canonical SPA path; also the deep-link base for chat connectors. */
	path?: string;
	/** Default sub-section id when no argument is supplied (e.g. `ai-model`). */
	section?: string;
}

/** Send the command text to the agent; an action/handler produces the reply. */
export interface CommandAgentTarget {
	kind: "agent";
	/** Optional hint naming the elizaOS action that should handle this. */
	action?: string;
}

/** Run a pure-client behavior with no agent round-trip. */
export interface CommandClientTarget {
	kind: "client";
	clientAction: ClientCommandAction;
}

/**
 * What a command *does* when invoked, expressed in a surface-agnostic way so
 * every surface (chat, TUI, Discord, Telegram) can interpret one catalog.
 * Defaults to `{ kind: "agent" }` when omitted.
 */
export type CommandTarget =
	| CommandNavigateTarget
	| CommandAgentTarget
	| CommandClientTarget;

/**
 * Named sources for runtime-resolved argument completions. The static catalog
 * stays serializable (no functions cross the wire); each surface resolves the
 * named source against its own live data (model list, view registry, …).
 */
export type CommandArgSource =
	| "models"
	| "views"
	| "settings-sections"
	| "skills"
	| "providers";

export interface CommandArgDefinition {
	name: string;
	description: string;
	required?: boolean;
	choices?: string[] | ((ctx: CommandArgChoiceContext) => string[]);
	/**
	 * Names a live source the surface should resolve completions from when
	 * static `choices` are absent or should be augmented. Always serializable.
	 */
	dynamicChoices?: CommandArgSource;
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
	/** Client surfaces this command appears on. Absent = every surface. */
	surfaces?: CommandSurface[];
	/** What the command does. Absent = `{ kind: "agent" }`. */
	target?: CommandTarget;
	/** Optional icon hint (lucide name) for rich menus. */
	icon?: string;
}

/**
 * The wire-safe shape of a command served over HTTP / handed to connectors.
 * Function-valued `choices` are dropped; everything else is JSON-serializable.
 */
export interface SerializedCommandArg {
	name: string;
	description: string;
	required?: boolean;
	choices?: string[];
	dynamicChoices?: CommandArgSource;
	captureRemaining?: boolean;
}

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
