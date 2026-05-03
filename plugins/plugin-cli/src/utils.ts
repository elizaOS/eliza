/**
 * CLI utilities
 *
 * Common utilities for CLI operations.
 */

import type {
	CliDeps,
	ParsedDuration,
	ProgressOptions,
	ProgressReporter,
} from "./types.js";

/**
 * Default CLI name
 */
export const DEFAULT_CLI_NAME = "elizaos";

/**
 * Default CLI version
 */
export const DEFAULT_CLI_VERSION = "1.0.0";

/**
 * Create default CLI dependencies
 */
export function createDefaultDeps(): CliDeps {
	return {
		log: (message: string) => console.log(message),
		error: (message: string) => console.error(message),
		exit: (code: number) => process.exit(code),
	};
}

/**
 * Create a progress reporter
 */
export function createProgressReporter(
	deps: CliDeps,
	options?: ProgressOptions,
): ProgressReporter {
	let running = false;
	let intervalId: ReturnType<typeof setInterval> | null = null;
	const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let frameIndex = 0;
	let currentMessage = options?.message ?? "";

	const clearLine = () => {
		if (process.stdout.isTTY) {
			process.stdout.write("\r\x1b[K");
		}
	};

	const writeSpinner = () => {
		if (process.stdout.isTTY && options?.spinner !== false) {
			clearLine();
			process.stdout.write(`${spinnerFrames[frameIndex]} ${currentMessage}`);
			frameIndex = (frameIndex + 1) % spinnerFrames.length;
		}
	};

	return {
		start(message: string) {
			currentMessage = message;
			running = true;
			if (options?.spinner !== false && process.stdout.isTTY) {
				writeSpinner();
				intervalId = setInterval(writeSpinner, 80);
			} else {
				deps.log(message);
			}
		},
		update(message: string) {
			currentMessage = message;
			if (!running && !process.stdout.isTTY) {
				deps.log(message);
			}
		},
		success(message: string) {
			this.stop();
			if (process.stdout.isTTY) {
				clearLine();
			}
			deps.log(`✓ ${message}`);
		},
		fail(message: string) {
			this.stop();
			if (process.stdout.isTTY) {
				clearLine();
			}
			deps.error(`✗ ${message}`);
		},
		stop() {
			running = false;
			if (intervalId) {
				clearInterval(intervalId);
				intervalId = null;
			}
			if (process.stdout.isTTY) {
				clearLine();
			}
		},
	};
}

/**
 * Execute with progress reporting
 */
export async function withProgress<T>(
	deps: CliDeps,
	message: string,
	fn: () => Promise<T>,
): Promise<T> {
	const progress = createProgressReporter(deps, { message, spinner: true });
	progress.start(message);
	try {
		const result = await fn();
		progress.success(message);
		return result;
	} catch (error) {
		progress.fail(error instanceof Error ? error.message : String(error));
		throw error;
	}
}

/**
 * Parse a duration string to milliseconds
 *
 * Supports formats like:
 * - "1s", "30s" (seconds)
 * - "1m", "5m" (minutes)
 * - "1h", "2h" (hours)
 * - "1d", "7d" (days)
 * - "1000" (milliseconds)
 */
export function parseDurationMs(input: string): ParsedDuration {
	const trimmed = input.trim().toLowerCase();

	// Check for number only (milliseconds)
	const numOnly = parseInt(trimmed, 10);
	if (!Number.isNaN(numOnly) && String(numOnly) === trimmed) {
		return { ms: numOnly, original: input, valid: true };
	}

	// Parse with unit
	const match = trimmed.match(
		/^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|ms|millisecond|milliseconds)?$/,
	);
	if (!match) {
		return { ms: 0, original: input, valid: false };
	}

	const value = parseFloat(match[1]);
	const unit = match[2] ?? "ms";

	let multiplier: number;
	switch (unit) {
		case "ms":
		case "millisecond":
		case "milliseconds":
			multiplier = 1;
			break;
		case "s":
		case "sec":
		case "second":
		case "seconds":
			multiplier = 1000;
			break;
		case "m":
		case "min":
		case "minute":
		case "minutes":
			multiplier = 60 * 1000;
			break;
		case "h":
		case "hr":
		case "hour":
		case "hours":
			multiplier = 60 * 60 * 1000;
			break;
		case "d":
		case "day":
		case "days":
			multiplier = 24 * 60 * 60 * 1000;
			break;
		default:
			return { ms: 0, original: input, valid: false };
	}

	return { ms: Math.round(value * multiplier), original: input, valid: true };
}

/**
 * Parse a timeout string with defaults
 */
export function parseTimeoutMs(
	input: string | undefined,
	defaultMs: number,
): number {
	if (!input) return defaultMs;
	const parsed = parseDurationMs(input);
	return parsed.valid ? parsed.ms : defaultMs;
}

/**
 * Format a CLI command with profile/env context
 */
export function formatCliCommand(
	command: string,
	options?: {
		cliName?: string;
		profile?: string;
		env?: string;
	},
): string {
	const parts = [options?.cliName ?? DEFAULT_CLI_NAME];

	if (options?.profile) {
		parts.push(`--profile ${options.profile}`);
	}

	if (options?.env) {
		parts.push(`--env ${options.env}`);
	}

	parts.push(command);

	return parts.join(" ");
}

/**
 * Resolve CLI name from argv
 */
export function resolveCliName(argv?: string[]): string {
	const args = argv ?? process.argv;
	if (args.length < 2) return DEFAULT_CLI_NAME;

	const scriptPath = args[1];
	const scriptName = scriptPath.split("/").pop() ?? DEFAULT_CLI_NAME;

	// Remove common extensions
	return scriptName.replace(/\.(js|ts|mjs|cjs)$/, "");
}

/**
 * Check if running interactively
 */
export function isInteractive(): boolean {
	return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let unitIndex = 0;
	let value = bytes;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Format duration to human readable string
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
	return `${(ms / 3600000).toFixed(1)}h`;
}
