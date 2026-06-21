/**
 * Navigation + client commands as first-class `CommandDefinition`s.
 *
 * These used to be defined inline in `connector-catalog.ts` as bare
 * `ConnectorCommand`s, which meant they could not carry `surfaces`, auth flags,
 * `category`, or flow through `serializeCommand` like agent commands do (#8790).
 * Defining them as `CommandDefinition`s with an explicit `target` and `surfaces`
 * lets the catalog treat agent / navigate / client commands uniformly:
 *
 *   - `navigate` commands open a destination in the Eliza app; `path` is the
 *     in-app deep link a connector advertises, `tab`/`viewId`/`section` are the
 *     routing hints the GUI/TUI use to open it deterministically. Offered on
 *     every surface (chat connectors reply with the deep link).
 *   - `client` commands run a GUI/TUI-only behavior with no remote surface, so
 *     they declare `surfaces: ["gui", "tui"]` and are filtered off chat
 *     connectors by surface, not by an ad-hoc branch.
 *
 * The `path`/`tab` values mirror the canonical route table in `@elizaos/ui`
 * (`navigation/index.ts` `TAB_PATHS`); keep them in sync there.
 */

import { getSettingsSectionChoices } from "./settings-sections";
import type { CommandDefinition, CommandSurface } from "./types";

const IN_APP_SURFACES: CommandSurface[] = ["gui", "tui"];

/** Navigation destinations — open an in-app route on any surface. */
const NAVIGATE_COMMANDS: CommandDefinition[] = [
	{
		key: "settings",
		nativeName: "settings",
		description: "Open agent settings",
		textAliases: ["/settings"],
		scope: "both",
		category: "docks",
		icon: "settings",
		target: { kind: "navigate", path: "/settings", tab: "settings" },
		acceptsArgs: true,
		args: [
			{
				name: "section",
				description: "Settings section to open",
				required: false,
				choices: getSettingsSectionChoices(),
				dynamicChoices: "settings-sections",
			},
		],
	},
	{
		key: "chat",
		nativeName: "chat",
		description: "Return to the chat",
		textAliases: ["/chat"],
		scope: "both",
		category: "docks",
		icon: "message-circle",
		target: { kind: "navigate", path: "/chat", tab: "chat" },
	},
	{
		key: "views",
		nativeName: "views",
		description: "Open the agent's views",
		textAliases: ["/views"],
		scope: "both",
		category: "docks",
		icon: "layout-grid",
		target: { kind: "navigate", path: "/views", tab: "views" },
		acceptsArgs: true,
		args: [
			{
				name: "view",
				description: "View to open",
				required: false,
				dynamicChoices: "views",
			},
		],
	},
	{
		key: "orchestrator",
		nativeName: "orchestrator",
		description: "Open the agent orchestrator",
		textAliases: ["/orchestrator"],
		scope: "both",
		category: "docks",
		icon: "workflow",
		target: { kind: "navigate", path: "/orchestrator", viewId: "orchestrator" },
	},
	{
		key: "character",
		nativeName: "character",
		description: "Open the character editor",
		textAliases: ["/character"],
		scope: "both",
		category: "docks",
		icon: "user",
		target: { kind: "navigate", path: "/character", tab: "character" },
	},
	{
		key: "knowledge",
		nativeName: "knowledge",
		description: "Open the knowledge base",
		textAliases: ["/knowledge"],
		scope: "both",
		category: "docks",
		icon: "book-open",
		target: {
			kind: "navigate",
			path: "/character/documents",
			tab: "documents",
		},
	},
	{
		key: "wallet",
		nativeName: "wallet",
		description: "Open the wallet & inventory",
		textAliases: ["/wallet"],
		scope: "both",
		category: "docks",
		icon: "wallet",
		target: { kind: "navigate", path: "/wallet", tab: "inventory" },
	},
	{
		key: "automations",
		nativeName: "automations",
		description: "Open automations",
		textAliases: ["/automations"],
		scope: "both",
		category: "docks",
		icon: "zap",
		target: { kind: "navigate", path: "/automations", tab: "automations" },
	},
	{
		key: "tasks",
		nativeName: "tasks",
		description: "Open tasks",
		textAliases: ["/tasks"],
		scope: "both",
		category: "docks",
		icon: "check-square",
		target: { kind: "navigate", path: "/apps/tasks", tab: "tasks" },
	},
	{
		key: "skills",
		nativeName: "skills",
		description: "Open the skills library",
		textAliases: ["/skills"],
		scope: "both",
		category: "docks",
		icon: "sparkles",
		target: { kind: "navigate", path: "/apps/skills", tab: "skills" },
	},
	{
		key: "plugins",
		nativeName: "plugins",
		description: "Open installed plugins",
		textAliases: ["/plugins"],
		scope: "both",
		category: "docks",
		icon: "plug",
		target: { kind: "navigate", path: "/apps/plugins", tab: "plugins" },
	},
	{
		key: "logs",
		nativeName: "logs",
		description: "Open the logs",
		textAliases: ["/logs"],
		scope: "both",
		category: "docks",
		icon: "scroll-text",
		target: { kind: "navigate", path: "/apps/logs", tab: "logs" },
	},
	{
		key: "database",
		nativeName: "database",
		description: "Open the database browser",
		textAliases: ["/database"],
		scope: "both",
		category: "docks",
		icon: "database",
		target: { kind: "navigate", path: "/apps/database", tab: "database" },
	},
];

/**
 * Client-only behaviors — run in the GUI/TUI, filtered off chat connectors by
 * surface (a Discord/Telegram user has nothing to clear or full-screen).
 */
const CLIENT_COMMANDS: CommandDefinition[] = [
	{
		key: "clear",
		nativeName: "clear",
		description: "Clear the current chat",
		textAliases: ["/clear"],
		scope: "both",
		category: "docks",
		icon: "eraser",
		surfaces: IN_APP_SURFACES,
		target: { kind: "client", clientAction: "clear-chat" },
	},
	{
		key: "fullscreen",
		nativeName: "fullscreen",
		description: "Toggle full-screen chat",
		textAliases: ["/fullscreen"],
		scope: "both",
		category: "docks",
		icon: "maximize",
		surfaces: IN_APP_SURFACES,
		target: { kind: "client", clientAction: "toggle-fullscreen" },
	},
	{
		key: "transcribe",
		nativeName: "transcribe",
		description:
			"Toggle long-form transcription mode (record-only; agent stays silent until an exit phrase)",
		textAliases: ["/transcribe"],
		scope: "both",
		category: "docks",
		icon: "mic",
		surfaces: IN_APP_SURFACES,
		target: { kind: "client", clientAction: "toggle-transcription" },
	},
];

/**
 * Navigation + client commands the app surfaces in addition to the agent
 * capabilities from the text command registry. Returns a fresh array so callers
 * can't mutate the shared definitions.
 */
export function navigationCommandDefinitions(): CommandDefinition[] {
	return [...NAVIGATE_COMMANDS, ...CLIENT_COMMANDS];
}
