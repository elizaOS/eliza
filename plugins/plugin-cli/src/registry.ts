/**
 * CLI command registry
 *
 * Provides command registration and management for the CLI plugin.
 */

import { logger } from "@elizaos/core";
import type { Command } from "commander";
import type { CliCommand, CliContext, CliRegistrationFn } from "./types.js";

/**
 * Internal registry of CLI commands
 */
const commands = new Map<string, CliCommand>();

/**
 * Register a CLI command
 */
export function registerCliCommand(command: CliCommand): void {
	if (commands.has(command.name)) {
		logger.warn(
			`[CLI] Command "${command.name}" already registered, replacing`,
		);
	}
	commands.set(command.name, command);
}

/**
 * Unregister a CLI command
 */
export function unregisterCliCommand(name: string): boolean {
	return commands.delete(name);
}

/**
 * Get a CLI command by name
 */
export function getCliCommand(name: string): CliCommand | undefined {
	return commands.get(name);
}

/**
 * List all registered CLI commands
 */
export function listCliCommands(): CliCommand[] {
	return Array.from(commands.values()).sort(
		(a, b) => (a.priority ?? 100) - (b.priority ?? 100),
	);
}

/**
 * Register all commands with the program
 */
export function registerAllCommands(ctx: CliContext): void {
	const sorted = listCliCommands();
	for (const command of sorted) {
		try {
			command.register(ctx);
			logger.debug(`[CLI] Registered command: ${command.name}`);
		} catch (error) {
			logger.error(
				`[CLI] Failed to register command "${command.name}":`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
}

/**
 * Clear all registered commands (for testing)
 */
export function clearCliCommands(): void {
	commands.clear();
}

/**
 * Helper to create a CLI command definition
 */
export function defineCliCommand(
	name: string,
	description: string,
	register: CliRegistrationFn,
	options?: {
		aliases?: string[];
		priority?: number;
	},
): CliCommand {
	return {
		name,
		description,
		register,
		aliases: options?.aliases,
		priority: options?.priority,
	};
}

/**
 * Helper to create a subcommand on an existing command
 */
export function addSubcommand(
	parent: Command,
	name: string,
	description: string,
): Command {
	return parent.command(name).description(description);
}
