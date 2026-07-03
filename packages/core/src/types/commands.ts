/**
 * Command system contract.
 *
 * The canonical `CommandDefinition` shape and the `CommandRegistryService`
 * runtime contract live here so hosts and plugins can register/read chat
 * commands through the runtime service registry without importing the
 * `@elizaos/plugin-commands` implementation (which owns the concrete registry,
 * parser, actions, and route surface and re-exports these types).
 */

import { Service } from "./service";

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

export interface CommandArgChoiceContext {
	provider?: string;
	model?: string;
	config?: Record<string, unknown>;
}

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
 * Runtime contract for the chat-command registry. `@elizaos/plugin-commands`
 * registers the concrete implementation under service type `"commands"`; hosts
 * and other plugins contribute commands through
 * `runtime.getService<CommandRegistryService>("commands")` so registrations
 * always land on the loaded plugin instance's per-runtime store (no module-
 * duplication drift) and never reset commands registered by earlier plugins.
 */
export abstract class CommandRegistryService extends Service {
	static override readonly serviceType = "commands";

	/**
	 * Register (or replace, by `key`) a command on this runtime's store without
	 * resetting existing registrations.
	 */
	abstract register(command: CommandDefinition): void;

	/** All commands currently registered for this runtime. */
	abstract list(): CommandDefinition[];
}
