/**
 * Navigation + client commands as first-class `CommandDefinition`s.
 *
 * Defining them as `CommandDefinition`s with an explicit `target` and `surfaces`
 * (rather than bare `ConnectorCommand`s) lets them carry `surfaces`, auth flags,
 * and `category`, flow through `serializeCommand` like agent commands, and be
 * treated uniformly by the catalog across agent / navigate / client kinds (#8790):
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
 * View-dependent action commands (#8798). Unlike the global navigation commands
 * above (which *open* a view), these invoke the in-view domain action and are
 * surfaced only while their view is foreground — the `views` scope is honoured by
 * `commandVisibleForView` and the active view is resolved server-side in
 * `/api/commands` (or passed as `?view=`). They target the agent so the planner
 * routes the body to the same action the in-view control invokes (calendar add →
 * CALENDAR, todos done → TODOS, …), keeping one canonical action per capability.
 * In-app only: a chat connector has no foreground view to scope against.
 */
const VIEW_SCOPED_COMMANDS: CommandDefinition[] = [
	{
		key: "calendar-add",
		nativeName: "calendar-add",
		description: "Add a calendar event (in the calendar view)",
		textAliases: ["/calendar-add"],
		scope: "both",
		category: "docks",
		icon: "calendar-plus",
		surfaces: IN_APP_SURFACES,
		views: ["calendar"],
		target: { kind: "agent" },
		acceptsArgs: true,
		args: [{ name: "event", description: "What to schedule", required: false }],
	},
	{
		key: "todos-add",
		nativeName: "todos-add",
		description: "Add a to-do (in the todos view)",
		textAliases: ["/todos-add"],
		scope: "both",
		category: "docks",
		icon: "list-plus",
		surfaces: IN_APP_SURFACES,
		views: ["todos"],
		target: { kind: "agent" },
		acceptsArgs: true,
		args: [{ name: "task", description: "What to do", required: false }],
	},
	{
		key: "todos-done",
		nativeName: "todos-done",
		description: "Complete a to-do (in the todos view)",
		textAliases: ["/todos-done"],
		scope: "both",
		category: "docks",
		icon: "check",
		surfaces: IN_APP_SURFACES,
		views: ["todos"],
		target: { kind: "agent" },
		acceptsArgs: true,
		args: [
			{ name: "task", description: "Which to-do to complete", required: false },
		],
	},
	{
		key: "documents-search",
		nativeName: "documents-search",
		description: "Search the knowledge base (in the documents view)",
		textAliases: ["/documents-search"],
		scope: "both",
		category: "docks",
		icon: "search",
		surfaces: IN_APP_SURFACES,
		views: ["documents"],
		target: { kind: "agent" },
		acceptsArgs: true,
		args: [
			{ name: "query", description: "What to search for", required: false },
		],
	},
];

/**
 * Navigation + client commands the app surfaces in addition to the agent
 * capabilities from the text command registry. Returns a fresh array so callers
 * can't mutate the shared definitions.
 */
export function navigationCommandDefinitions(): CommandDefinition[] {
	return [...NAVIGATE_COMMANDS, ...CLIENT_COMMANDS, ...VIEW_SCOPED_COMMANDS];
}
