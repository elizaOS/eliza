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
	| "skills";

/**
 * The surfaces a command is offered on. Omitted/undefined on a definition means
 * "all surfaces" (the default). `serializeCommand(cmd, surface)` filters on this.
 */
export type CommandSurface = "gui" | "tui" | "discord" | "telegram";

/**
 * A live source a client resolves an argument's choices from at render time
 * (the registry can't enumerate models/views/skills/providers statically). The
 * definition tags the source; the client fetches the concrete values.
 */
export type CommandArgSource =
	| "models"
	| "views"
	| "settings-sections"
	| "skills"
	| "providers";

/**
 * Client-only behaviors the in-app surfaces (GUI/TUI) run directly, with no
 * agent round-trip and no remote surface. Connectors filter `client` targets
 * out (a Discord/Telegram user has nothing to clear or full-screen).
 */
export type ClientCommandAction =
	| "clear-chat"
	| "new-conversation"
	| "toggle-fullscreen"
	| "open-command-palette"
	| "show-commands"
	| "toggle-transcription";

/**
 * Where a command executes — the single discriminant every surface routes on:
 *   - `agent`    → the command runs through the agent (a deterministic command
 *                  action handles it; `action` names that handler when known).
 *   - `navigate` → opens a destination in the Eliza app; `path` is the in-app
 *                  deep link, `tab`/`viewId`/`section` are routing hints.
 *   - `client`   → a GUI/TUI-only behavior with no remote surface.
 */
export type CommandTarget =
	| { kind: "agent"; action?: string }
	| {
			kind: "navigate";
			path: string;
			tab?: string;
			viewId?: string;
			section?: string;
	  }
	| { kind: "client"; clientAction: ClientCommandAction };

export interface CommandArgDefinition {
	name: string;
	description: string;
	required?: boolean;
	choices?: string[] | ((ctx: CommandArgChoiceContext) => string[]);
	/**
	 * A live choice source the client resolves at render time. Carried through
	 * serialization so the client knows to fetch models/views/skills/etc. for
	 * this arg instead of relying on static `choices`.
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
	/**
	 * Where this command executes. Omitted = `{ kind: "agent" }` (the default):
	 * a deterministic command action handles it through the agent. Navigation /
	 * client commands set this explicitly so every surface routes them the same.
	 */
	target?: CommandTarget;
	/**
	 * The surfaces this command is offered on. Omitted/undefined = all surfaces
	 * (the default). `serializeCommand(cmd, surface)` filters on this so the
	 * `?surface=` catalog query returns only what that surface should render.
	 */
	surfaces?: CommandSurface[];
	/** Optional icon hint (lucide name) for menu rendering. */
	icon?: string;
	/**
	 * View ids for which this command is *view-dependent*: it is only surfaced in
	 * the command catalog while one of these views is the active (foreground)
	 * surface. Omitted/undefined = globally available (the default). A non-empty
	 * list scopes the command to those views — e.g. a `/calendar add` command that
	 * only makes sense while the calendar view is open. (#8798)
	 */
	views?: string[];
}

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
