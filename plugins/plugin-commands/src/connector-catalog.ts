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

/** Where a connector command executes. */
export type ConnectorCommandTarget =
	| { kind: "agent" }
	| { kind: "navigate"; path: string }
	| { kind: "client" };

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
 * Navigation commands the app surfaces in addition to the agent capabilities.
 * These open a destination in the Eliza app rather than routing through the
 * agent. `path` is the in-app deep link the connector can advertise.
 */
function navigationCommands(): ConnectorCommand[] {
	return [
		{
			name: "settings",
			description: "Open agent settings",
			target: { kind: "navigate", path: "/settings" },
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
			name: "views",
			description: "Open the agent's views",
			target: { kind: "navigate", path: "/views" },
			options: [],
		},
		{
			name: "orchestrator",
			description: "Open the agent orchestrator",
			target: { kind: "navigate", path: "/orchestrator" },
			options: [],
		},
		{
			name: "knowledge",
			description: "Open the knowledge base",
			target: { kind: "navigate", path: "/knowledge" },
			options: [],
		},
		{
			name: "plugins",
			description: "Open installed plugins",
			target: { kind: "navigate", path: "/plugins" },
			options: [],
		},
	];
}

/**
 * Build the connector command catalog for a given connector.
 *
 * The catalog is the union of:
 *   - agent-capability commands derived from the enabled, connector-scoped text
 *     command registry, and
 *   - the app navigation commands.
 *
 * @param _connector the connector key (e.g. "discord"). Reserved for
 *   per-connector filtering; the current catalog is uniform across connectors.
 */
export function getConnectorCommands(_connector: string): ConnectorCommand[] {
	const agentCommands = DEFAULT_COMMANDS.filter(
		(command) => command.enabled !== false && isConnectorScoped(command),
	).map(mapRegistryCommand);

	const navigation = navigationCommands();

	// Navigation commands win on name collisions (they own those surfaces).
	const navigationNames = new Set(navigation.map((command) => command.name));
	const agentOnly = agentCommands.filter(
		(command) => !navigationNames.has(command.name),
	);

	return [...agentOnly, ...navigation];
}
