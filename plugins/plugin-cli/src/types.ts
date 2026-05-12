/**
 * CLI plugin types
 *
 * Core types for CLI command registration and execution.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { Command } from "commander";

/**
 * Logger interface for CLI context
 */
export interface CliLogger {
	info: (msg: string) => void;
	warn: (msg: string) => void;
	error: (msg: string) => void;
	debug?: (msg: string) => void;
}

/**
 * CLI context provided to command handlers
 */
export interface CliContext {
	/** Commander program instance */
	program: Command;
	/** Optional runtime getter for plugins that need it */
	getRuntime?: () => IAgentRuntime | null;
	/** CLI name (e.g., "elizaos", "otto") */
	cliName: string;
	/** CLI version */
	version: string;
	/** Optional configuration object */
	config?: Record<string, unknown>;
	/** Optional workspace directory */
	workspaceDir?: string;
	/** Optional logger for CLI output */
	logger?: CliLogger;
}

/**
 * CLI command registration function signature
 */
export type CliRegistrationFn = (ctx: CliContext) => void;

/**
 * CLI command definition
 */
export interface CliCommand {
	/** Command name (e.g., "run", "config") */
	name: string;
	/** Command description */
	description: string;
	/** Command aliases */
	aliases?: string[];
	/** Registration function */
	register: CliRegistrationFn;
	/** Priority for registration order (lower = earlier) */
	priority?: number;
}

/**
 * CLI plugin configuration
 */
export interface CliPluginConfig {
	/** CLI name */
	name?: string;
	/** CLI version */
	version?: string;
	/** Commands to register */
	commands?: CliCommand[];
}

/**
 * Progress reporter interface
 */
export interface ProgressReporter {
	/** Start progress reporting */
	start(message: string): void;
	/** Update progress message */
	update(message: string): void;
	/** Complete with success */
	success(message: string): void;
	/** Complete with failure */
	fail(message: string): void;
	/** Stop progress reporting */
	stop(): void;
}

/**
 * Progress options
 */
export interface ProgressOptions {
	/** Initial message */
	message?: string;
	/** Whether to show spinner */
	spinner?: boolean;
}

/**
 * CLI dependencies for command execution
 */
export interface CliDeps {
	/** Log function */
	log: (message: string) => void;
	/** Error function */
	error: (message: string) => void;
	/** Exit function */
	exit: (code: number) => void;
}

/**
 * Duration parsing result
 */
export interface ParsedDuration {
	/** Duration in milliseconds */
	ms: number;
	/** Original string */
	original: string;
	/** Whether parsing was successful */
	valid: boolean;
}

/**
 * Command options commonly used across CLI commands
 */
export interface CommonCommandOptions {
	/** JSON output format */
	json?: boolean;
	/** Verbose output */
	verbose?: boolean;
	/** Quiet mode (minimal output) */
	quiet?: boolean;
	/** Force action without confirmation */
	force?: boolean;
	/** Dry run (show what would happen) */
	dryRun?: boolean;
}
