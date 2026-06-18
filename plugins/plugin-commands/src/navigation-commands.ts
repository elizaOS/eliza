/**
 * Navigation + client commands — the surface-agnostic half of the universal
 * slash-command catalog.
 *
 * These commands carry a declarative `target` (navigate / client) instead of
 * routing to the agent. They are interpreted per surface:
 *   - GUI  → select the tab/section, or run the client behavior
 *   - TUI  → navigate the view registry
 *   - chat connectors (Discord/Telegram) → reply with a deep link to the view
 *
 * The tab ids and section ids below are the app's stable, public route
 * identifiers; keeping them here as plain data is what lets a single catalog
 * drive navigation on every surface without each surface re-declaring it.
 */

import type { CommandDefinition } from "./types";

/**
 * Settings sub-sections a user can jump to with `/settings <section>`. The
 * `id` is the canonical section id; `aliases` are the friendly tokens a user
 * can type. Mirrors `SETTINGS_SECTIONS` + hash aliases in @elizaos/ui.
 */
export const SETTINGS_SECTION_ALIASES: ReadonlyArray<{
	id: string;
	aliases: string[];
}> = [
	{ id: "identity", aliases: ["basics", "identity", "profile"] },
	{ id: "ai-model", aliases: ["model", "models", "providers", "provider", "ai", "cloud"] },
	{ id: "runtime", aliases: ["runtime"] },
	{ id: "appearance", aliases: ["appearance", "theme", "look"] },
	{ id: "voice", aliases: ["voice", "tts", "speech"] },
	{ id: "capabilities", aliases: ["capabilities", "abilities"] },
	{ id: "apps", aliases: ["apps", "views"] },
	{ id: "remote-plugins", aliases: ["remote-plugins", "remote"] },
	{ id: "connectors", aliases: ["connectors", "connections", "integrations"] },
	{ id: "app-permissions", aliases: ["app-permissions"] },
	{ id: "wallet-rpc", aliases: ["wallet", "rpc", "wallet-rpc"] },
	{ id: "permissions", aliases: ["permissions", "perms"] },
	{ id: "secrets", aliases: ["secrets", "vault", "keys"] },
	{ id: "security", aliases: ["security"] },
	{ id: "updates", aliases: ["updates", "update"] },
	{ id: "advanced", aliases: ["advanced", "fine-tuning"] },
];

/** Friendly tokens accepted by `/settings <section>`, for arg completion. */
const SETTINGS_SECTION_CHOICES: string[] = SETTINGS_SECTION_ALIASES.flatMap(
	(s) => s.aliases,
);

/** Resolve a user-typed settings token to its canonical section id. */
export function resolveSettingsSection(token: string): string | undefined {
	const normalized = token.trim().toLowerCase();
	if (!normalized) return undefined;
	for (const section of SETTINGS_SECTION_ALIASES) {
		if (section.id === normalized) return section.id;
		if (section.aliases.includes(normalized)) return section.id;
	}
	return undefined;
}

/**
 * The canonical navigation + client commands. Merged into the per-runtime
 * registry alongside the agent-capability `DEFAULT_COMMANDS`.
 */
export const NAVIGATION_COMMANDS: ReadonlyArray<CommandDefinition> = [
	{
		key: "settings",
		nativeName: "settings",
		description: "Open settings (optionally jump to a section, e.g. /settings model)",
		textAliases: ["/settings", "/config-ui", "/preferences"],
		scope: "both",
		category: "navigation",
		acceptsArgs: true,
		args: [
			{
				name: "section",
				description: "Section to open (model, voice, connectors, security, …)",
				choices: SETTINGS_SECTION_CHOICES,
				dynamicChoices: "settings-sections",
			},
		],
		target: { kind: "navigate", tab: "settings", path: "/settings" },
		icon: "settings",
	},
	{
		key: "orchestrator",
		nativeName: "orchestrator",
		description: "Open the agent orchestrator workbench",
		textAliases: ["/orchestrator", "/workbench", "/agents"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", viewId: "orchestrator", path: "/orchestrator" },
		icon: "workflow",
	},
	{
		key: "views",
		nativeName: "views",
		description: "Open the apps & views launcher",
		textAliases: ["/views", "/apps"],
		scope: "both",
		category: "navigation",
		acceptsArgs: true,
		args: [
			{
				name: "view",
				description: "Open a specific view by id",
				dynamicChoices: "views",
			},
		],
		target: { kind: "navigate", tab: "views", path: "/views" },
		icon: "layout-grid",
	},
	{
		key: "open-chat",
		nativeName: "chat",
		description: "Return to the chat surface",
		textAliases: ["/chat"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "chat", path: "/chat" },
		icon: "message-circle",
	},
	{
		key: "plugins",
		nativeName: "plugins",
		description: "Open installed plugins",
		textAliases: ["/plugins"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "plugins", path: "/apps/plugins" },
		icon: "blocks",
	},
	{
		key: "skills-view",
		nativeName: "skills",
		description: "Open the skills library",
		textAliases: ["/skills"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "skills", path: "/skills" },
		icon: "graduation-cap",
	},
	{
		key: "wallet",
		nativeName: "wallet",
		description: "Open your wallet & inventory",
		textAliases: ["/wallet", "/inventory"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "inventory", path: "/inventory" },
		icon: "wallet",
	},
	{
		key: "knowledge",
		nativeName: "knowledge",
		description: "Open your knowledge & documents",
		textAliases: ["/knowledge", "/documents", "/docs"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "documents", path: "/documents" },
		icon: "book-open",
	},
	{
		key: "character",
		nativeName: "character",
		description: "Open the character editor",
		textAliases: ["/character", "/persona"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "character", path: "/character" },
		icon: "user-round",
	},
	{
		key: "automations",
		nativeName: "automations",
		description: "Open automations & heartbeats",
		textAliases: ["/automations", "/triggers", "/heartbeats"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "automations", path: "/automations" },
		icon: "timer",
	},
	{
		key: "tasks-view",
		nativeName: "tasks",
		description: "Open the tasks view",
		textAliases: ["/tasks"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "tasks", path: "/tasks" },
		icon: "list-checks",
	},
	{
		key: "logs-view",
		nativeName: "logs",
		description: "Open the logs view",
		textAliases: ["/logs"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "logs", path: "/apps/logs" },
		icon: "scroll-text",
	},
	{
		key: "database",
		nativeName: "database",
		description: "Open the database browser",
		textAliases: ["/database", "/db"],
		scope: "both",
		category: "navigation",
		target: { kind: "navigate", tab: "database", path: "/apps/database" },
		icon: "database",
	},
	// `/voice` is intentionally NOT a nav command — it's owned by the `tts`
	// command (toggle text-to-speech). Voice *settings* are reached via
	// `/settings voice`.
	// ── Pure-client commands (no agent round-trip) ───────────────────────────
	{
		key: "clear",
		nativeName: "clear",
		description: "Clear the current chat thread",
		textAliases: ["/clear", "/cls"],
		scope: "text",
		category: "session",
		surfaces: ["gui", "tui"],
		target: { kind: "client", clientAction: "clear-chat" },
		icon: "eraser",
	},
	{
		key: "fullscreen",
		nativeName: "fullscreen",
		description: "Toggle full-screen chat",
		textAliases: ["/fullscreen", "/expand"],
		scope: "text",
		category: "session",
		surfaces: ["gui"],
		target: { kind: "client", clientAction: "toggle-fullscreen" },
		icon: "maximize-2",
	},
];
