/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 */

// Configure Node.js-specific streaming context manager (AsyncLocalStorage)
import { setStreamingContextManager } from "./streaming-context";
import { createNodeStreamingContextManager } from "./streaming-context.node";

setStreamingContextManager(createNodeStreamingContextManager());

// Export all core modules
export * from "./actions";
// Export configuration and plugin modules - will be removed once cli cleanup
export * from "./character";
export * from "./database";
export * from "./elizaos";
export * from "./entities";
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
export * from "./services/default-message-service";
export * from "./services/message-service";
export * from "./settings";
export * from "./streaming-context";
// Export everything from types
export * from "./types";
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
