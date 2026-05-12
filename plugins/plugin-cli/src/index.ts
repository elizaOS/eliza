/**
 * @elizaos/plugin-cli
 *
 * CLI framework plugin for ElizaOS agents
 *
 * Provides:
 * - CLI command registration and management
 * - Progress reporting utilities
 * - Duration/timeout parsing
 * - Common CLI dependencies
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { Command } from "commander";

// Registry
export {
	addSubcommand,
	clearCliCommands,
	defineCliCommand,
	getCliCommand,
	listCliCommands,
	registerAllCommands,
	registerCliCommand,
	unregisterCliCommand,
} from "./registry.js";
// Types
export * from "./types.js";

// Utils
export {
	createDefaultDeps,
	createProgressReporter,
	DEFAULT_CLI_NAME,
	DEFAULT_CLI_VERSION,
	formatBytes,
	formatCliCommand,
	formatDuration,
	isInteractive,
	parseDurationMs,
	parseTimeoutMs,
	resolveCliName,
	withProgress,
} from "./utils.js";

import { listCliCommands, registerAllCommands } from "./registry.js";
import type { CliContext } from "./types.js";
import {
	DEFAULT_CLI_NAME,
	DEFAULT_CLI_VERSION,
	resolveCliName,
} from "./utils.js";

/**
 * Build the Commander program with all registered commands
 */
export function buildProgram(options?: {
	name?: string;
	version?: string;
	getRuntime?: () => IAgentRuntime | null;
}): Command {
	const cliName = options?.name ?? resolveCliName();
	const version = options?.version ?? DEFAULT_CLI_VERSION;

	const program = new Command()
		.name(cliName)
		.version(version)
		.description(`${cliName} - ElizaOS agent CLI`);

	const ctx: CliContext = {
		program,
		getRuntime: options?.getRuntime,
		cliName,
		version,
	};

	// Register all commands
	registerAllCommands(ctx);

	return program;
}

/**
 * Run the CLI with the given arguments
 */
export async function runCli(
	argv?: string[],
	options?: {
		name?: string;
		version?: string;
		getRuntime?: () => IAgentRuntime | null;
	},
): Promise<void> {
	const program = buildProgram(options);

	try {
		await program.parseAsync(argv ?? process.argv);
	} catch (error) {
		if (error instanceof Error) {
			// Commander throws an error for --help and --version
			if (error.message.includes("outputHelp")) {
				return;
			}
		}
		throw error;
	}
}

/**
 * CLI Plugin for ElizaOS
 *
 * Provides CLI command infrastructure for the agent runtime.
 *
 * Configuration:
 * - CLI_NAME: CLI command name (default: "elizaos")
 * - CLI_VERSION: CLI version string
 *
 * @example
 * ```typescript
 * import { cliPlugin, buildProgram, registerCliCommand, defineCliCommand } from '@elizaos/plugin-cli';
 *
 * // Register a custom command
 * registerCliCommand(defineCliCommand(
 *   'mycommand',
 *   'My custom command',
 *   (ctx) => {
 *     ctx.program.command('mycommand')
 *       .description('My custom command')
 *       .action(() => console.log('Hello!'));
 *   }
 * ));
 *
 * // Build and run
 * const program = buildProgram();
 * await program.parseAsync(process.argv);
 * ```
 */
export const cliPlugin: Plugin = {
	name: "cli",
	description: "CLI framework plugin for command registration and execution",

	providers: [],
	actions: [],
	services: [],
	routes: [],

	config: {
		CLI_NAME: DEFAULT_CLI_NAME,
		CLI_VERSION: DEFAULT_CLI_VERSION,
	},

	async init(
		_config: Record<string, string>,
		_runtime: IAgentRuntime,
	): Promise<void> {
		try {
			const commands = listCliCommands();

			logger.info(
				{ commandCount: commands.length },
				"[CLIPlugin] Plugin initialized",
			);
		} catch (error) {
			logger.error(
				"[CLIPlugin] Error initializing:",
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	},
};

export default cliPlugin;

// Re-export Command for convenience
export { Command } from "commander";
