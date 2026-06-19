/**
 * Connector-neutral command catalog.
 *
 * The text command registry (`registry.ts`) describes what an agent can *do*
 * via slash commands; the catalog re-projects that registry, plus the app's
 * navigation surface, into a connector-neutral shape (`ConnectorCommand`) that
 * a connector (Discord, Telegram, …) maps onto its own native command surface.
 *
 * Each command declares a `target` discriminating where it executes:
 *   - `agent`    → the reconstructed command text is routed through the agent's
 *                  message pipeline (these come from the text command registry).
 *   - `navigate` → opens a destination in the Eliza app (settings, views, …);
 *                  `path` is the in-app deep link.
 *   - `client`   → GUI/TUI-only behavior that has no remote surface; connectors
 *                  filter these out (none are emitted for remote connectors).
 *
 * Options carry a fully-resolved `choices: string[]` (always an array, possibly
 * empty) so connectors never have to evaluate the registry's function-valued
 * choices themselves.
 */

import { DEFAULT_COMMANDS } from "./registry";
import { getSettingsSectionChoices } from "./settings-sections";
import type { CommandArgDefinition, CommandDefinition } from "./types";

/**
 * Client-only behaviors the in-app surfaces (GUI/TUI) run directly, with no
 * agent round-trip and no remote surface. Mirrors the GUI's `ClientCommandAction`
 * (packages/ui `client-types-commands.ts`); kept here so the catalog stays
 * connector-neutral without depending on the UI package.
 */
export type ClientCommandAction =
	| "clear-chat"
	| "new-conversation"
	| "toggle-fullscreen"
	| "open-command-palette"
	| "show-commands";

/** Where a connector command executes. */
export type ConnectorCommandTarget =
	| { kind: "agent" }
	| { kind: "navigate"; path: string; tab?: string; viewId?: string; section?: string }
	| { kind: "client"; clientAction: ClientCommandAction };

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
	target: ConnectorCommandTarget;
	options: ConnectorCommandOption[];
}

/**
 * Connectors expose a native command surface, so only commands that make sense
 * remotely are emitted. The text registry's `scope` already encodes this:
 * `text`-only commands (e.g. `/bash`) are local-shell behaviors that never
 * belong on a connector surface.
 */
function isConnectorScoped(command: CommandDefinition): boolean {
	return command.scope !== "text";
}

/** Resolve a registry arg's choices to a concrete string array. */
function resolveArgChoices(arg: CommandArgDefinition): string[] {
	if (!arg.choices) return [];
	// Catalog projection is runtime-independent, so function-valued choices
	// (which need a live provider/model context) collapse to free-form here.
	if (typeof arg.choices === "function") return [];
	return arg.choices;
}

function mapRegistryArg(arg: CommandArgDefinition): ConnectorCommandOption {
	return {
		name: arg.name,
		description: arg.description,
		required: arg.required ?? false,
		choices: resolveArgChoices(arg),
	};
}

/** Project an enabled, connector-scoped registry command onto the catalog. */
function mapRegistryCommand(command: CommandDefinition): ConnectorCommand {
	const options = command.args?.map(mapRegistryArg) ?? [];
	return {
		name: command.nativeName ?? command.key,
		description: command.description,
		target: { kind: "agent" },
		options,
	};
}

/**
 * Navigation + client commands the app surfaces in addition to the agent
 * capabilities. Navigation commands open a destination in the Eliza app rather
 * than routing through the agent; `path` is the in-app deep link a connector can
 * advertise, and `tab`/`viewId` are routing hints the GUI/TUI use to open the
 * destination deterministically. Client commands run a GUI/TUI-only behavior.
 *
 * The `path`/`tab` values mirror the canonical route table in
 * `@elizaos/ui` (`navigation/index.ts` `TAB_PATHS`); keep them in sync there.
 */
function navigationCommands(): ConnectorCommand[] {
	return [
		{
			name: "settings",
			description: "Open agent settings",
			target: { kind: "navigate", path: "/settings", tab: "settings" },
			options: [
				{
					name: "section",
					description: "Settings section to open",
					required: false,
					choices: getSettingsSectionChoices(),
				},
			],
		},
		{
			name: "chat",
			description: "Return to the chat",
			target: { kind: "navigate", path: "/chat", tab: "chat" },
			options: [],
		},
		{
			name: "views",
			description: "Open the agent's views",
			target: { kind: "navigate", path: "/views", tab: "views" },
			options: [],
		},
		{
			name: "orchestrator",
			description: "Open the agent orchestrator",
			target: { kind: "navigate", path: "/orchestrator", viewId: "orchestrator" },
			options: [],
		},
		{
			name: "character",
			description: "Open the character editor",
			target: { kind: "navigate", path: "/character", tab: "character" },
			options: [],
		},
		{
			name: "knowledge",
			description: "Open the knowledge base",
			target: { kind: "navigate", path: "/character/documents", tab: "documents" },
			options: [],
		},
		{
			name: "wallet",
			description: "Open the wallet & inventory",
			target: { kind: "navigate", path: "/wallet", tab: "inventory" },
			options: [],
		},
		{
			name: "automations",
			description: "Open automations",
			target: { kind: "navigate", path: "/automations", tab: "automations" },
			options: [],
		},
		{
			name: "tasks",
			description: "Open tasks",
			target: { kind: "navigate", path: "/apps/tasks", tab: "tasks" },
			options: [],
		},
		{
			name: "skills",
			description: "Open the skills library",
			target: { kind: "navigate", path: "/apps/skills", tab: "skills" },
			options: [],
		},
		{
			name: "plugins",
			description: "Open installed plugins",
			target: { kind: "navigate", path: "/apps/plugins", tab: "plugins" },
			options: [],
		},
		{
			name: "logs",
			description: "Open the logs",
			target: { kind: "navigate", path: "/apps/logs", tab: "logs" },
			options: [],
		},
		{
			name: "database",
			description: "Open the database browser",
			target: { kind: "navigate", path: "/apps/database", tab: "database" },
			options: [],
		},
		// Client-only behaviors — run in the GUI/TUI, filtered off chat connectors
		// (a Discord/Telegram user has nothing to clear or full-screen).
		{
			name: "clear",
			description: "Clear the current chat",
			target: { kind: "client", clientAction: "clear-chat" },
			options: [],
		},
		{
			name: "fullscreen",
			description: "Toggle full-screen chat",
			target: { kind: "client", clientAction: "toggle-fullscreen" },
			options: [],
		},
	];
}

/**
 * Build the connector command catalog for a given surface.
 *
 * The catalog is the union of:
 *   - agent-capability commands derived from the enabled, connector-scoped text
 *     command registry, and
 *   - the app navigation + client commands.
 *
 * Client-only commands (GUI/TUI behaviors like clear / full-screen) are emitted
 * to the in-app surfaces but filtered off chat connectors, which have no surface
 * to run them on.
 *
 * @param surface the target surface ("gui" | "tui" | "discord" | "telegram").
 */
export function getConnectorCommands(surface: string): ConnectorCommand[] {
	const agentCommands = DEFAULT_COMMANDS.filter(
		(command) => command.enabled !== false && isConnectorScoped(command),
	).map(mapRegistryCommand);

	const isChatConnector = surface === "discord" || surface === "telegram";
	const navigation = navigationCommands().filter(
		(command) => !(isChatConnector && command.target.kind === "client"),
	);

	// Navigation commands win on name collisions (they own those surfaces).
	const navigationNames = new Set(navigation.map((command) => command.name));
	const agentOnly = agentCommands.filter(
		(command) => !navigationNames.has(command.name),
	);

	return [...agentOnly, ...navigation];
}
