/**
 * Connector-neutral command catalog.
 *
 * The text command registry (`registry.ts`) describes the agent's slash
 * capabilities; `navigation-commands.ts` describes the app's navigation/client
 * commands. Both are `CommandDefinition`s now, so the catalog treats them
 * uniformly: it unions them, dedupes (navigation wins name collisions), filters
 * by surface (`surfaces`) and active view (`views`), and projects onto either:
 *
 *   - `ConnectorCommand` — the shape a connector (Discord, Telegram, …) maps
 *     onto its native command surface (`getConnectorCommands`), or
 *   - `SerializedCommand` — the wire shape `GET /api/commands` serves the web
 *     composer (`getCatalogCommands`), via `serializeCommand`.
 *
 * Each command declares a `target` discriminating where it executes (`agent` /
 * `navigate` / `client`). `ConnectorCommand` options carry a fully-resolved
 * `choices: string[]` so connectors never evaluate function-valued choices.
 */

import { navigationCommandDefinitions } from "./navigation-commands";
import { DEFAULT_COMMANDS, getEnabledCommandsForRuntime } from "./registry";
import { commandVisibleForSurface, serializeCommand } from "./serialize";
import type {
	CommandDefinition,
	CommandSurface,
	CommandTarget,
	SerializedCommand,
	SerializedCommandSource,
} from "./types";

// Re-export the canonical command-target types for connectors that still import
// them from here. `ConnectorCommandTarget` is now an alias of `CommandTarget`.
export type { ClientCommandAction, CommandTarget } from "./types";
export type ConnectorCommandTarget = CommandTarget;

/** A single argument of a connector command. */
export interface ConnectorCommandOption {
	name: string;
	description: string;
	required: boolean;
	/** Resolved choice values; empty when the option is free-form. */
	choices: string[];
}

/** A connector-neutral command ready to map onto a native command surface. */
export interface ConnectorCommand {
	name: string;
	description: string;
	target: CommandTarget;
	options: ConnectorCommandOption[];
	/**
	 * View ids this command is scoped to (#8798): present only while one of these
	 * views is the active surface. Omitted = globally available.
	 */
	views?: string[];
	/**
	 * Auth flags from the definition, so connector bridges can gate the NATIVE
	 * picker (e.g. Discord default_member_permissions) instead of showing a
	 * command that execute-time trust will refuse anyway (#16154 deferral).
	 * Execution is still re-checked server-side — these are presentation gates.
	 */
	requiresAuth: boolean;
	requiresElevated: boolean;
}

const KNOWN_SURFACES: ReadonlySet<string> = new Set([
	"gui",
	"tui",
	"discord",
	"telegram",
]);

/**
 * Whether a command with the given `views` scoping is visible for the active
 * view. Global commands (no `views`, or an empty list) are always visible;
 * view-scoped commands appear only when their view is foreground. (#8798)
 */
export function commandVisibleForView(
	views: readonly string[] | undefined,
	activeViewId: string | null | undefined,
): boolean {
	if (!views || views.length === 0) return true;
	if (!activeViewId) return false;
	return views.includes(activeViewId);
}

/**
 * Connectors expose a native command surface, so only commands that make sense
 * remotely are emitted. The text registry's `scope` encodes this: `text`-only
 * commands (e.g. `/bash`) are local-shell behaviors that never belong on a
 * connector surface.
 */
function isConnectorScoped(command: CommandDefinition): boolean {
	return command.scope !== "text";
}

function commandName(command: CommandDefinition): string {
	return command.nativeName ?? command.key;
}

/**
 * The unified command list: enabled, connector-scoped agent commands from the
 * text registry plus the navigation/client commands. Navigation/client commands
 * win on name collisions (they own those surfaces).
 */
function unifiedDefinitions(agentId?: string | null): CommandDefinition[] {
	const agentCommands = agentId
		? getEnabledCommandsForRuntime(agentId)
		: DEFAULT_COMMANDS.filter((command) => command.enabled !== false);
	const agent = agentCommands.filter(isConnectorScoped);
	const navigation = navigationCommandDefinitions();
	const navigationNames = new Set(navigation.map(commandName));
	const agentOnly = agent.filter(
		(command) => !navigationNames.has(commandName(command)),
	);
	return [...agentOnly, ...navigation];
}

function normalizeSurface(surface: string): CommandSurface | null {
	return KNOWN_SURFACES.has(surface) ? (surface as CommandSurface) : null;
}

/** The surface- and view-filtered unified definitions. */
function visibleDefinitions(
	surface: string,
	activeViewId: string | null | undefined,
	agentId?: string | null,
): CommandDefinition[] {
	const normalized = normalizeSurface(surface);
	return unifiedDefinitions(agentId)
		.filter((command) => commandVisibleForSurface(command.surfaces, normalized))
		.filter((command) => commandVisibleForView(command.views, activeViewId));
}

function mapDefinitionArg(
	arg: NonNullable<CommandDefinition["args"]>[number],
): ConnectorCommandOption {
	return {
		name: arg.name,
		description: arg.description,
		required: arg.required ?? false,
		choices: Array.isArray(arg.choices) ? arg.choices : [],
	};
}

/** Project a definition onto the connector-neutral `ConnectorCommand` shape. */
function toConnectorCommand(command: CommandDefinition): ConnectorCommand {
	return {
		name: commandName(command),
		description: command.description,
		target: command.target ?? { kind: "agent" },
		options: (command.args ?? []).map(mapDefinitionArg),
		...(command.views && command.views.length > 0
			? { views: command.views }
			: {}),
		requiresAuth: command.requiresAuth ?? false,
		requiresElevated: command.requiresElevated ?? false,
	};
}

/**
 * Build the connector command catalog for a given surface (Discord, Telegram, …).
 *
 * @param surface "gui" | "tui" | "discord" | "telegram".
 * @param options.activeViewId when set, view-scoped commands (#8798) are
 *   included only if this is one of their views; global commands always appear.
 *   When unset, view-scoped commands are filtered out entirely.
 */
export function getConnectorCommands(
	surface: string,
	options: { activeViewId?: string | null; agentId?: string | null } = {},
): ConnectorCommand[] {
	return visibleDefinitions(surface, options.activeViewId, options.agentId).map(
		toConnectorCommand,
	);
}

/**
 * Build the wire-safe catalog (`SerializedCommand[]`) served by
 * `GET /api/commands`. This is the pure projection: surface- and view-filtered
 * unified definitions, each run through `serializeCommand` so `surfaces`, auth
 * flags, `category`, `dynamicChoices`, and `icon` all survive intact.
 */
export function getCatalogCommands(
	surface: string,
	options: {
		activeViewId?: string | null;
		agentId?: string | null;
		source?: SerializedCommandSource;
	} = {},
): SerializedCommand[] {
	return visibleDefinitions(surface, options.activeViewId, options.agentId).map(
		(command) =>
			serializeCommand(
				command,
				options.source ? { source: options.source } : {},
			),
	);
}
