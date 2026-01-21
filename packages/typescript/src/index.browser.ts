/**
 * Browser-specific entry point for @elizaos/core
 *
 * This file exports only browser-compatible modules and provides
 * stubs or alternatives for Node.js-specific functionality.
 * Streaming context manager is auto-detected at runtime.
 */

// Export core modules (all browser-compatible after refactoring)
export * from "./actions";
export * from "./character";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
export * from "./logger";
export * from "./memory";
export * from "./prompts";
export * from "./roles";
export * from "./runtime";
// Export schemas
export * from "./schemas/character";
export * from "./search";
export * from "./services";
export * from "./services/message";
export * from "./services/trajectoryLogger";
export * from "./settings";
export * from "./streaming-context";
export * from "./trajectory-context";
// Export everything from types (type-only, safe for browser)
export * from "./types";
export * from "./types/message-service";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export * from "./utils/buffer";
// Export browser-compatible utilities
export * from "./utils/environment";

// Browser-specific exports or stubs for Node-only features
export const isBrowser = true;
export const isNode = false;

/**
 * Browser stub for server health checks
 * In browser environment, this is a no-op
 */
export const serverHealth = {
  check: async () => ({ status: "not-applicable", environment: "browser" }),
  isHealthy: () => true,
};
