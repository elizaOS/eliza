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
export * from "./character-loader";
// Export character utilities and loader (includes re-exports from constants)
export * from "./character-utils";
// Export additional constants not re-exported by character-utils
export {
  CANONICAL_SECRET_KEYS,
  CHANNEL_OPTIONAL_SECRETS,
  LOCAL_MODEL_PROVIDERS,
  isSecretKeyAlias,
  getAliasesForKey,
  isCanonicalSecretKey,
  getProviderForApiKey,
  getRequiredSecretsForChannel,
  getAllSecretsForChannel,
  type CanonicalSecretKey,
} from "./constants";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
// Export generated action/provider/evaluator specs from centralized prompts
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export * from "./logger";
// Export markdown utilities
export * from "./markdown";
// Export media utilities
export * from "./media";
export * from "./memory";
// Export network utilities (SSRF protection, secure fetch)
export * from "./network";
export * from "./plugin";
// Export plugin discovery and manifest utilities
export * from "./plugins";
export * from "./prompts";
export * from "./roles";
export * from "./runtime";
// Export base table schemas (abstract SchemaTable definitions + buildBaseTables factory)
export * from "./schemas/index";
export { buildBaseTables, type BaseTables } from "./schemas/index";
// Export character schemas
export * from "./schemas/character";
export * from "./search";
export * from "./secrets";
// Export security utilities
export * from "./security";
export * from "./services";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/hook";
export * from "./services/message";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/pairing-migration";
export * from "./services/plugin-hooks";
export * from "./services/tool-policy";
export * from "./services/trajectoryLogger";
// Export sessions utilities
export * from "./sessions";
export * from "./settings";
export * from "./streaming-context";
export * from "./trajectory-context";
// Export everything from types
export * from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
export * from "./types/plugin-manifest";
// Export utils first to avoid circular dependency issues
export * from "./utils";
// Export validation utilities
export * from "./validation";
// Export onboarding types and utilities
export * from "./types/onboarding";
// Export onboarding services
export * from "./services/onboarding-state";
export * from "./services/onboarding-cli";
export * from "./services/onboarding-rpc";
// Export onboarding providers
export * from "./providers/onboarding-progress";
// Export skill eligibility provider
export * from "./providers/skill-eligibility";
export * from "./utils/buffer";
// Export channel utilities (room/world helpers)
export * from "./utils/channel-utils";
// Export browser-compatible utilities
export * from "./utils/environment";
// Export Node-specific utilities
export * from "./utils/node";
// Export streaming utilities
export * from "./utils/streaming";

// Node-specific exports
export const isBrowser = false;
export const isNode = true;
