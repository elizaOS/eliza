/**
 * Main entry point for @elizaos/core
 *
 * This is the default export that includes all modules.
 * The build system creates separate bundles for Node.js and browser environments.
 * Package.json conditional exports handle the routing to the correct build.
 */

// Suppress AI SDK warnings by default (set AI_SDK_LOG_WARNINGS=true to enable)
(globalThis as Record<string, unknown>).AI_SDK_LOG_WARNINGS ??= false;

// Import directly from specific modules:
// - ./actions for action utilities
// - ./bootstrap/index for bootstrap plugin
// - ./character for character utilities
// - ./database for database utilities
// - ./entities for entity utilities
// - ./logger for logging
// - ./memory for memory utilities
// - ./prompts for prompts
// - ./roles for role utilities
// - ./runtime for runtime
// - ./schemas/character for character schemas
// - ./search for search utilities
// - ./secrets for secrets utilities
// - ./services for services
// - ./services/message for message service
// - ./settings for settings
// - ./streaming-context for streaming context
// - ./types/* for type definitions
// - ./utils/buffer for buffer utilities
// - ./utils/environment for environment utilities
// - ./utils/paths for path utilities (Node.js only)
// - ./utils/streaming for streaming utilities
// - ./utils/server-health for server health utilities

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
