/**
 * Re-export shim for the structured logger.
 *
 * The logger implementation moved to the standalone `@elizaos/logger` package so
 * UI/renderer consumers can import it without pulling the whole `@elizaos/core`
 * runtime bundle into their module graph. This file keeps the historical
 * `@elizaos/core` import paths (`./logger`, and `export * from "./logger"` in
 * the index barrels) working unchanged — the public logger symbols, plus the
 * default export.
 */

export type {
	LogEntry,
	Logger,
	LoggerBindings,
	LogListener,
} from "@elizaos/logger";
export {
	__loggerTestHooks,
	addLogListener,
	createLogger,
	customLevels,
	default,
	elizaLogger,
	logChatIn,
	logChatOut,
	logger,
	logPrompt,
	logResponse,
	recentLogs,
	removeLogListener,
} from "@elizaos/logger";
