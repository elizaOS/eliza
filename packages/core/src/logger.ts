/**
 * Re-export shim for the structured logger.
 *
 * The logger implementation moved to the standalone `@elizaos/logger` package so
 * UI/renderer consumers can import it without pulling the whole `@elizaos/core`
 * runtime bundle into their module graph. This file keeps the historical
 * `@elizaos/core` import paths (`./logger`, and `export * from "./logger"` in
 * the index barrels) working unchanged — every symbol, plus the default export.
 */
export * from "@elizaos/logger";
export { default } from "@elizaos/logger";
