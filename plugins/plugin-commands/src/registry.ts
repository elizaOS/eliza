/**
 * Command registry - defines all available chat commands
 *
 * IMPORTANT: The registry uses module-level state for convenience, but
 * provides `cloneCommands()` and `resetCommands()` so that `init()` can
 * work on isolated copies per runtime. The `init()` function in the main
 * plugin file should clone before mutating to avoid cross-agent contamination.
 */

import type { CommandDefinition } from "./types";

// Default command definitions (frozen reference — never mutate these directly)
const DEFAULT_COMMANDS: ReadonlyArray<CommandDefinition> = [
	// Status commands
	{
		key: "help",
		nativeName: "help",
		description: "Show available commands",
		textAliases: ["/help", "/h", "/?"],
		scope: "both",
		category: "status",
		acceptsArgs: false,
	},
	{
		key: "commands",
		nativeName: "commands",
		description: "List all commands",
		textAliases: ["/commands", "/cmds"],
		scope: "both",
		category: "status",
		acceptsArgs: false,
	},
	{
		key: "status",
		nativeName: "status",
		description: "Show current session status",
		textAliases: ["/status", "/s"],
		scope: "both",
		category: "status",
		acceptsArgs: false,
	},
	{
		key: "context",
		nativeName: "context",
		description: "Show current context information",
		textAliases: ["/context", "/ctx"],
		scope: "both",
		category: "status",
		acceptsArgs: true,
		args: [{ name: "mode", description: "Output mode (list, detail, json)" }],
	},
	{
		key: "whoami",
		nativeName: "whoami",
		description: "Show your identity information",
		textAliases: ["/whoami", "/who"],
		scope: "both",
		category: "status",
		acceptsArgs: false,
	},

	// Session commands
	{
		key: "stop",
		nativeName: "stop",
		description: "Stop current operation",
		textAliases: ["/stop", "/abort", "/cancel"],
		scope: "both",
		category: "session",
		acceptsArgs: false,
	},
	{
		key: "restart",
		nativeName: "restart",
		description: "Restart the session",
		textAliases: ["/restart"],
		scope: "both",
		category: "session",
		acceptsArgs: false,
		requiresAuth: true,
	},
	{
		key: "reset",
		nativeName: "reset",
		description: "Reset session state",
		textAliases: ["/reset"],
		scope: "both",
		category: "session",
		acceptsArgs: false,
		requiresAuth: true,
	},
	{
		key: "new",
		nativeName: "new",
		description: "Start a new conversation",
		textAliases: ["/new"],
		scope: "both",
		category: "session",
		acceptsArgs: false,
	},
	{
		key: "compact",
		nativeName: "compact",
		description: "Compact conversation history",
		textAliases: ["/compact"],
		scope: "both",
		category: "session",
		acceptsArgs: true,
		args: [
			{ name: "instructions", description: "Optional compaction instructions" },
		],
	},

	// Options commands
	{
		key: "think",
		nativeName: "think",
		description: "Set thinking level",
		textAliases: ["/think", "/thinking", "/t"],
		scope: "both",
		category: "options",
		acceptsArgs: true,
		args: [
			{ name: "level", description: "off, minimal, low, medium, high, xhigh" },
		],
	},
	{
		key: "verbose",
		nativeName: "verbose",
		description: "Set verbose output level",
		textAliases: ["/verbose", "/v"],
		scope: "both",
		category: "options",
		acceptsArgs: true,
		args: [{ name: "level", description: "off, on, full" }],
	},
	{
		key: "reasoning",
		nativeName: "reasoning",
		description: "Set reasoning visibility",
		textAliases: ["/reasoning", "/reason"],
		scope: "both",
		category: "options",
		acceptsArgs: true,
		args: [{ name: "level", description: "off, on, stream" }],
	},
	{
		key: "elevated",
		nativeName: "elevated",
		description: "Set elevated permission mode",
		textAliases: ["/elevated", "/elev"],
		scope: "both",
		category: "options",
		acceptsArgs: true,
		args: [{ name: "level", description: "off, on, ask, full" }],
		requiresAuth: true,
	},
	{
		key: "model",
		nativeName: "model",
		description: "Set or show current model",
		textAliases: ["/model", "/m"],
		scope: "both",
		category: "options",
		acceptsArgs: true,
		args: [{ name: "model", description: "provider/model or alias" }],
	},
	{
		key: "models",
		nativeName: "models",
		description: "List available models",
		textAliases: ["/models"],
		scope: "both",
		category: "options",
		acceptsArgs: false,
	},
	{
		key: "usage",
		nativeName: "usage",
		description: "Show token usage",
		textAliases: ["/usage"],
		scope: "both",
		category: "options",
		acceptsArgs: false,
	},
	{
		key: "queue",
		nativeName: "queue",
		description: "Set queue mode",
		textAliases: ["/queue", "/q"],
		scope: "both",
		category: "options",
		acceptsArgs: true,
		args: [
			{
				name: "mode",
				description: "steer, followup, collect, interrupt, or options",
			},
		],
	},

	// Management commands
	{
		key: "allowlist",
		nativeName: "allowlist",
		description: "Manage sender allowlist",
		textAliases: ["/allowlist", "/allow"],
		scope: "both",
		category: "management",
		acceptsArgs: true,
		args: [
			{ name: "action", description: "list, add, remove" },
			{ name: "value", description: "sender to add/remove" },
		],
		requiresAuth: true,
	},
	{
		key: "approve",
		nativeName: "approve",
		description: "Approve or deny a pending action",
		textAliases: ["/approve"],
		scope: "both",
		category: "management",
		acceptsArgs: true,
		args: [
			{ name: "id", description: "Approval ID", required: true },
			{ name: "action", description: "allow-once, allow-always, deny" },
		],
		requiresAuth: true,
	},
	{
		key: "subagents",
		nativeName: "subagents",
		description: "Manage subagents",
		textAliases: ["/subagents", "/sub"],
		scope: "both",
		category: "management",
		acceptsArgs: true,
		args: [{ name: "action", description: "list, stop, log, info, send" }],
		requiresAuth: true,
	},
	{
		key: "config",
		nativeName: "config",
		description: "View or set configuration",
		textAliases: ["/config", "/cfg"],
		scope: "both",
		category: "management",
		acceptsArgs: true,
		args: [
			{ name: "key", description: "Configuration key" },
			{ name: "value", description: "Value to set" },
		],
		requiresAuth: true,
		enabled: false, // Disabled by default
	},
	{
		key: "debug",
		nativeName: "debug",
		description: "Debug information",
		textAliases: ["/debug"],
		scope: "both",
		category: "management",
		acceptsArgs: true,
		requiresAuth: true,
		enabled: false, // Disabled by default
	},

	// Media commands
	{
		key: "tts",
		nativeName: "tts",
		description: "Text-to-speech settings",
		textAliases: ["/tts", "/voice"],
		scope: "both",
		category: "media",
		acceptsArgs: true,
		args: [
			{
				name: "action",
				description: "on, off, status, provider, limit, audio",
			},
		],
	},

	// Tools commands
	{
		key: "bash",
		nativeName: "bash",
		description: "Execute shell command",
		textAliases: ["/bash", "/sh", "/!"],
		scope: "text",
		category: "tools",
		acceptsArgs: true,
		args: [
			{
				name: "command",
				description: "Shell command to execute",
				captureRemaining: true,
			},
		],
		requiresAuth: true,
		requiresElevated: true,
	},
];

// ── Per-runtime command storage ──────────────────────────────────────────
// Each agent runtime gets its own isolated command set via `initForRuntime()`.
// The module-level state is used as a fallback for convenience (tests, etc.).
//
// Why a WeakMap? Agent runtimes may be created/destroyed; we don't want to
// leak memory by holding strong references to disposed runtimes.

interface CommandStore {
	commands: CommandDefinition[];
	aliasMap: Map<string, CommandDefinition> | null;
}

/** Per-runtime stores keyed by agentId */
const runtimeStores = new Map<string, CommandStore>();
/** Fallback store for when no runtime context is set */
const fallbackStore: CommandStore = {
	commands: DEFAULT_COMMANDS.map((c) => ({ ...c })),
	aliasMap: null,
};
/** Currently active store (set during init, reset on test teardown) */
let activeStore: CommandStore = fallbackStore;

/**
 * Initialize an isolated command store for a specific runtime.
 * Called from plugin init() to prevent cross-agent contamination.
 */
export function initForRuntime(agentId: string): void {
	const store: CommandStore = {
		commands: DEFAULT_COMMANDS.map((c) => ({ ...c })),
		aliasMap: null,
	};
	runtimeStores.set(agentId, store);
	activeStore = store;
}

/**
 * Set the active command store for a given runtime.
 * Providers and actions should call this before accessing commands.
 */
export function useRuntime(agentId: string): void {
	const store = runtimeStores.get(agentId);
	if (store) {
		activeStore = store;
	}
}

/**
 * Get all registered commands
 */
export function getCommands(): CommandDefinition[] {
	return [...activeStore.commands];
}

/**
 * Get enabled commands
 */
export function getEnabledCommands(): CommandDefinition[] {
	return activeStore.commands.filter((cmd) => cmd.enabled !== false);
}

/**
 * Get commands by category
 */
export function getCommandsByCategory(category: string): CommandDefinition[] {
	return activeStore.commands.filter(
		(cmd) => cmd.category === category && cmd.enabled !== false,
	);
}

/**
 * Register a custom command
 */
export function registerCommand(command: CommandDefinition): void {
	// Remove existing command with same key
	activeStore.commands = activeStore.commands.filter(
		(c) => c.key !== command.key,
	);
	activeStore.commands.push(command);
	activeStore.aliasMap = null; // Invalidate cache
}

/**
 * Register multiple commands
 */
export function registerCommands(newCommands: CommandDefinition[]): void {
	for (const command of newCommands) {
		registerCommand(command);
	}
}

/**
 * Unregister a command
 */
export function unregisterCommand(key: string): void {
	activeStore.commands = activeStore.commands.filter((c) => c.key !== key);
	activeStore.aliasMap = null;
}

/**
 * Reset to default commands (for the active store)
 */
export function resetCommands(): void {
	activeStore.commands = DEFAULT_COMMANDS.map((c) => ({ ...c }));
	activeStore.aliasMap = null;
}

/**
 * Build and cache alias map for the active store
 */
function getAliasMap(): Map<string, CommandDefinition> {
	if (activeStore.aliasMap) return activeStore.aliasMap;

	activeStore.aliasMap = new Map();
	for (const command of activeStore.commands) {
		if (command.enabled === false) continue;

		for (const alias of command.textAliases) {
			const normalized = alias.toLowerCase().trim();
			if (!activeStore.aliasMap.has(normalized)) {
				activeStore.aliasMap.set(normalized, command);
			}
		}
	}
	return activeStore.aliasMap;
}

/**
 * Find command by alias
 */
export function findCommandByAlias(
	alias: string,
): CommandDefinition | undefined {
	const map = getAliasMap();
	return map.get(alias.toLowerCase().trim());
}

/**
 * Find command by key
 */
export function findCommandByKey(key: string): CommandDefinition | undefined {
	return activeStore.commands.find((c) => c.key === key);
}

/**
 * Check if text starts with any command alias
 */
export function startsWithCommand(text: string): CommandDefinition | undefined {
	const map = getAliasMap();
	const normalized = text.toLowerCase().trim();

	// Check exact match first
	for (const [alias, command] of map) {
		if (normalized === alias) {
			return command;
		}
		if (
			normalized.startsWith(`${alias} `) ||
			normalized.startsWith(`${alias}:`)
		) {
			return command;
		}
	}

	return undefined;
}
