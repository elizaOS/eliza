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
 * Where a command can appear. `gui`/`tui` are the in-app surfaces; `discord`/
 * `telegram` are the chat connectors. A command with no `surfaces` is available
 * everywhere; one with an explicit list is restricted to those surfaces (e.g. a
 * GUI-only `/fullscreen` is never exposed to Discord/Telegram).
 */
export type CommandSurface = "gui" | "tui" | "discord" | "telegram";

/**
 * How a command is handled once matched:
 *   - `agent`    → routed to the agent's message pipeline (the default).
 *   - `navigate` → an in-app deep link (a tab/view + a stable route path); chat
 *                  connectors reply with the link instead of running it.
 *   - `client`   → a pure client-side behavior (e.g. clear the chat), no agent
 *                  round-trip; has no connector surface.
 */
export type CommandTarget =
	| { kind: "agent" }
	| { kind: "navigate"; tab?: string; viewId?: string; path: string }
	| { kind: "client"; clientAction: string };

export interface CommandArgDefinition {
	name: string;
	description: string;
	required?: boolean;
	choices?: string[] | ((ctx: CommandArgChoiceContext) => string[]);
	/**
	 * Key for a surface-resolved choice list (e.g. "settings-sections", "views")
	 * the UI fills in at render time. Static `choices` are used for connectors;
	 * this is the dynamic hint for the in-app surfaces.
	 */
	dynamicChoices?: string;
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
	/** Surfaces this command appears on; omit for "everywhere". */
	surfaces?: CommandSurface[];
	/** How the command is handled when matched; defaults to `{ kind: "agent" }`. */
	target?: CommandTarget;
	/** Optional icon id (lucide name) for surfaces that render a command list. */
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
