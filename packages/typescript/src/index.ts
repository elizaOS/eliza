/**
 * Main entry point for @elizaos/core
 *
 * This is the default export that includes all modules.
 * The build system creates separate bundles for Node.js and browser environments.
 * Package.json conditional exports handle the routing to the correct build.
 */

// Suppress AI SDK warnings by default (set AI_SDK_LOG_WARNINGS=true to enable)
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS ??= false;

// Then all other exports
export * from "./actions";
// Export bootstrap plugin and capabilities
export * from "./bootstrap/index";
// Export character utilities
export * from "./character";
export * from "./database";
export * from "./entities";
export * from "./logger";
export * from "./memory";
export * from "./prompts";
export * from "./roles";
export * from "./runtime";
// Export schemas
export * from "./schemas/character";
export * from "./search";
export * from "./secrets";
export * from "./services";
export * from "./services/message";
export * from "./types/message-service";
export * from "./settings";
// Export streaming context utilities
export * from "./streaming-context";
// Export everything from types
export * from "./types";
// Export utils first to avoid circular dependency issues
export * from "./utils";
// Export buffer utilities
export * from "./utils/buffer";
// Export environment utilities
export * from "./utils/environment";
// Export path utilities - these are Node.js specific but needed for backward compatibility
// Browser builds will handle this through conditional exports in package.json
export * from "./utils/paths";
// Export streaming utilities
export * from "./utils/streaming";

// Environment detection utilities
interface GlobalWithWindow {
  window?: Window;
  document?: Document;
}

export const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as GlobalWithWindow).window !== "undefined" &&
  typeof (globalThis as GlobalWithWindow).document !== "undefined";
export const isNode =
  typeof process !== "undefined" &&
  typeof process.versions !== "undefined" &&
  typeof process.versions.node !== "undefined";

// Re-export server health with a conditional stub for browser environments
export * from "./utils/server-health";
