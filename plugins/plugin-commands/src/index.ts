/**
 * Plugin Commands - Chat command system for Eliza agents
 *
 * Provides a slash-command system with:
 * - /help, /status, /commands for information
 * - /stop, /reset, /compact for session control
 * - /think, /verbose, /model for options
 * - /allowlist, /approve for management
 * - /tts for media
 * - /bash for tools (elevated)
 *
 * INTEGRATION NOTES:
 * - Commands are registered as Actions with strict validate() that only
 *   matches slash-prefixed messages (e.g. /help, !stop). This prevents
 *   conflicts with bootstrap actions (STATUS, IGNORE) and messaging plugins.
 * - Similes use ONLY slash-command forms (no natural language) so the LLM
 *   won't accidentally route "I need help" to HELP_COMMAND instead of REPLY.
 * - The registry is scoped per runtime to prevent cross-agent state leaks.
 * - The COMMAND_REGISTRY provider includes the command list in the LLM context
 *   ONLY when the message is a command, reducing prompt noise for normal messages.
 */

import {
	type IAgentRuntime,
	logger,
	type Memory,
	type Plugin,
	type Provider,
	type ProviderResult,
	type State,
} from "@elizaos/core";
import { detectCommand, hasCommand, normalizeCommandBody } from "./parser";
import {
	findCommandByAlias,
	findCommandByKey,
	getCommandsByCategory,
	getEnabledCommands,
	initForRuntime,
	registerCommand,
	unregisterCommand,
	useRuntime,
} from "./registry";
import type { CommandContext, CommandDefinition, CommandResult } from "./types";

export * from "./parser";
export * from "./registry";
// Re-export everything
export * from "./types";

/**
 * Provider that exposes available commands to the LLM context.
 *
 * Only injects the full command list when the message looks like a command.
 * For normal messages, returns a minimal hint so the LLM knows commands
 * exist but doesn't get a wall of command documentation in its context.
 */
export const commandRegistryProvider: Provider = {
	name: "COMMAND_REGISTRY",
	description: "Available chat commands and their descriptions",
	descriptionCompressed: "Available chat commands and descriptions.",
	dynamic: true,
	contexts: ["general", "automation"],
	contextGate: { anyOf: ["general", "automation"] },
	cacheStable: true,
	cacheScope: "agent",
	async get(
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> {
		// Scope to the correct runtime's command store
		useRuntime(runtime.agentId);

		const text = message.content?.text ?? "";
		const isCommand = hasCommand(text);
		const commands = getEnabledCommands();

		if (isCommand) {
			// Full command context for command messages — helps the LLM select
			// the right action
			const commandList = commands.map((cmd) => {
				const auth = cmd.requiresAuth ? " (requires auth)" : "";
				return `- ${cmd.textAliases[0]}: ${cmd.description}${auth}`;
			});

			return {
				text: `The user sent a slash command. Available commands:\n${commandList.join("\n")}\n\nIMPORTANT: This is a slash command — respond by executing the matching command action, not with conversational text.`,
				values: {
					commandCount: commands.length,
					isCommand: true,
					hasElevatedCommands: commands.some((c) => c.requiresElevated),
				},
				data: { commands, isCommand: true },
			};
		}

		// Minimal context for non-command messages — don't pollute the prompt
		return {
			text: "",
			values: {
				commandCount: commands.length,
				isCommand: false,
			},
			data: { isCommand: false },
		};
	},
};

/**
 * Format command result for display
 */
export function formatCommandResult(result: CommandResult): string {
	if (result.error) {
		return `Error: ${result.error}`;
	}
	return result.reply ?? "Command executed";
}

/**
 * Check if a sender is authorized
 */
export function isAuthorized(
	context: CommandContext,
	command: CommandDefinition,
): boolean {
	if (!command.requiresAuth) {
		return true;
	}
	return context.isAuthorized;
}

/**
 * Check if a sender has elevated permissions
 */
export function isElevated(
	context: CommandContext,
	command: CommandDefinition,
): boolean {
	if (!command.requiresElevated) {
		return true;
	}
	return context.isElevated;
}

/**
 * Plugin Commands
 *
 * Provides chat commands as Eliza actions. Commands are detected
 * by their text aliases (e.g., /help, /status) and executed as actions.
 *
 * Design decisions for messaging integration:
 * 1. Actions use strict validate() — only true for slash-prefixed messages
 * 2. Similes are slash-only — no natural language to prevent LLM misrouting
 * 3. Provider is context-aware — full docs for commands, empty for normal msgs
 * 4. Registry is scoped per agentId — no cross-agent contamination
 * 5. Events use proper EventType enums — not raw strings
 */
export const commandsPlugin: Plugin = {
	name: "commands",
	description: "Chat command system with /help, /status, /reset, etc.",

	providers: [commandRegistryProvider],

	// Self-declared auto-enable: activate when features.commands is enabled.
	autoEnable: {
		shouldEnable: (_env, config) => {
			const f = (config?.features as Record<string, unknown> | undefined)
				?.commands;
			return (
				f === true ||
				(typeof f === "object" &&
					f !== null &&
					(f as { enabled?: unknown }).enabled !== false)
			);
		},
	},

	config: {
		COMMANDS_ENABLED: "true",
		COMMANDS_CONFIG_ENABLED: "false",
		COMMANDS_DEBUG_ENABLED: "false",
		COMMANDS_BASH_ENABLED: "false",
		COMMANDS_RESTART_ENABLED: "true",
	},

	tests: [
		{
			name: "command-detection",
			tests: [
				{
					name: "Detect command prefix",
					fn: async (_runtime: IAgentRuntime) => {
						if (!hasCommand("/help")) {
							throw new Error("Should detect /help command");
						}
						if (!hasCommand("/status test")) {
							throw new Error("Should detect /status with args");
						}
						if (hasCommand("hello world")) {
							throw new Error("Should not detect plain text as command");
						}
						logger.success("Command prefix detection works correctly");
					},
				},
				{
					name: "Parse command with args",
					fn: async (_runtime: IAgentRuntime) => {
						const detection = detectCommand("/think:high");
						if (!detection.isCommand) {
							throw new Error("Should detect think command");
						}
						if (detection.command?.key !== "think") {
							throw new Error(
								`Expected key 'think', got '${detection.command?.key}'`,
							);
						}
						if (detection.command?.args[0] !== "high") {
							throw new Error(
								`Expected arg 'high', got '${detection.command?.args[0]}'`,
							);
						}
						logger.success("Command argument parsing works correctly");
					},
				},
				{
					name: "Normalize command body",
					fn: async (_runtime: IAgentRuntime) => {
						const normalized1 = normalizeCommandBody("/status: test");
						if (normalized1 !== "/status test") {
							throw new Error(`Expected '/status test', got '${normalized1}'`);
						}

						const normalized2 = normalizeCommandBody("@bot /help", "bot");
						if (normalized2 !== "/help") {
							throw new Error(`Expected '/help', got '${normalized2}'`);
						}

						logger.success("Command normalization works correctly");
					},
				},
				{
					name: "Find command by alias",
					fn: async (_runtime: IAgentRuntime) => {
						const cmd = findCommandByAlias("/h");
						if (!cmd) {
							throw new Error("Should find help command by /h alias");
						}
						if (cmd.key !== "help") {
							throw new Error(`Expected key 'help', got '${cmd.key}'`);
						}
						logger.success("Command alias lookup works correctly");
					},
				},
				{
					name: "Find command by key",
					fn: async (_runtime: IAgentRuntime) => {
						const cmd = findCommandByKey("status");
						if (!cmd) {
							throw new Error("Should find status command by key");
						}
						if (cmd.key !== "status") {
							throw new Error(`Expected key 'status', got '${cmd.key}'`);
						}
						logger.success("Command key lookup works correctly");
					},
				},
			],
		},
		{
			name: "command-registry",
			tests: [
				{
					name: "Get enabled commands",
					fn: async (_runtime: IAgentRuntime) => {
						const commands = getEnabledCommands();
						if (commands.length === 0) {
							throw new Error("Should have enabled commands");
						}
						// Check some expected commands exist
						const cmdHelp = commands.some((c) => c.key === "help");
						const cmdStatus = commands.some((c) => c.key === "status");
						if (!cmdHelp || !cmdStatus) {
							throw new Error("Should have help and status commands");
						}
						logger.success("Command registry works correctly");
					},
				},
				{
					name: "Register custom command",
					fn: async (_runtime: IAgentRuntime) => {
						const customCmd: CommandDefinition = {
							key: "test-custom",
							description: "Test custom command",
							textAliases: ["/test-custom", "/tc"],
							scope: "text",
						};

						registerCommand(customCmd);
						const found = findCommandByKey("test-custom");
						if (!found) {
							throw new Error("Should find registered custom command");
						}

						unregisterCommand("test-custom");
						const notFound = findCommandByKey("test-custom");
						if (notFound) {
							throw new Error("Should not find unregistered command");
						}

						logger.success("Custom command registration works correctly");
					},
				},
				{
					name: "Get commands by category",
					fn: async (_runtime: IAgentRuntime) => {
						const statusCommands = getCommandsByCategory("status");
						if (statusCommands.length === 0) {
							throw new Error("Should have status category commands");
						}
						const allStatus = statusCommands.every(
							(c) => c.category === "status",
						);
						if (!allStatus) {
							throw new Error(
								"All returned commands should be in status category",
							);
						}
						logger.success("Command categorization works correctly");
					},
				},
			],
		},
	],

	async init(config, runtime) {
		logger.log("[plugin-commands] Initializing command system");

		// Initialize an isolated command store for this runtime
		// This prevents cross-agent contamination in multi-agent deployments
		initForRuntime(runtime.agentId);

		// Configure command enablement from config
		const configEnabled = config.COMMANDS_CONFIG_ENABLED === "true";
		const debugEnabled = config.COMMANDS_DEBUG_ENABLED === "true";
		const bashEnabled = config.COMMANDS_BASH_ENABLED === "true";
		const restartEnabled = config.COMMANDS_RESTART_ENABLED !== "false";

		// Update command enabled states (now on the isolated copy)
		const configCmd = findCommandByKey("config");
		if (configCmd) {
			configCmd.enabled = configEnabled;
		}

		const debugCmd = findCommandByKey("debug");
		if (debugCmd) {
			debugCmd.enabled = debugEnabled;
		}

		const bashCmd = findCommandByKey("bash");
		if (bashCmd) {
			bashCmd.enabled = bashEnabled;
		}

		const restartCmd = findCommandByKey("restart");
		if (restartCmd) {
			restartCmd.enabled = restartEnabled;
		}

		const enabledCount = getEnabledCommands().length;
		logger.log(
			`[plugin-commands] ${enabledCount} commands enabled for agent ${runtime.agentId}`,
		);
	},
};

export default commandsPlugin;
