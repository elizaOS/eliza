/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 * Streaming context manager is auto-detected at runtime.
 */

// Export all core modules
export * from "./actions";
// Export capabilities and plugin creation
export * from "./basic-capabilities/index";
// Export configuration and plugin modules - will be removed once cli cleanup
export * from "./character";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
// Export generated action/provider/evaluator specs from centralized prompts
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export * from "./logger";
export * from "./memory";
export * from "./plugin";
export * from "./prompts";
export * from "./roles";
export * from "./runtime";
// Export schemas
export * from "./schemas/character";
export * from "./search";
export * from "./secrets";
export * from "./services";
export * from "./services/message";
export * from "./services/trajectoryLogger";
export * from "./settings";
export * from "./streaming-context";
export * from "./trajectory-context";
// Export everything from types
export * from "./types";
export * from "./types/message-service";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export * from "./utils/buffer";
// Export browser-compatible utilities
export * from "./utils/environment";
// Export Node-specific utilities
export * from "./utils/node";
// Export streaming utilities
export * from "./utils/streaming";

// Node-specific exports
export const isBrowser = false;
export const isNode = true;
