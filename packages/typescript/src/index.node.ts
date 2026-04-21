/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 * Streaming context manager is auto-detected at runtime.
 */

// Export all core modules
export * from "./actions";
// Export configuration and plugin modules - will be removed once cli cleanup
export * from "./character";
// Export character utilities
export * from "./character-utils";
// Connection management (ensureConnection/ensureConnections) - standalone batch helpers
export * from "./connection";
// Export additional constants not re-exported by character-utils
export {
	CANONICAL_SECRET_KEYS,
	type CanonicalSecretKey,
	CHANNEL_OPTIONAL_SECRETS,
	getAliasesForKey,
	getAllSecretsForChannel,
	getProviderForApiKey,
	getRequiredSecretsForChannel,
	isCanonicalSecretKey,
	isSecretKeyAlias,
	LOCAL_MODEL_PROVIDERS,
} from "./constants";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
// Keep evaluator runtime symbols explicit in the node entrypoint. Bun has
// dropped some of these when they were only re-exported transitively through
// the basic-capabilities barrel, which leaves dangling exports in dist.
export {
	factRefinementEvaluator,
	skillExtractionEvaluator,
	skillRefinementEvaluator,
} from "./features/advanced-capabilities/evaluators/index";
export * from "./features/advanced-memory";
// Export capabilities and plugin creation
export * from "./features/basic-capabilities/index";
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
export { getOptimizationRootDir } from "./optimization-root-dir";
export * from "./plugin";
export * from "./plugins";

export * from "./prompts";
// Export onboarding providers
export * from "./providers/onboarding-progress";
// Export skill eligibility provider
export * from "./providers/skill-eligibility";
// Provisioning (migrations, agent/entity/room, embedding dimension) - node only
export * from "./provisioning";
export * from "./roles";
export * from "./runtime";
// Runtime composition (loadCharacters, createRuntimes, getBasicCapabilitiesSettings, mergeSettingsInto) - node only
export * from "./runtime-composition";
// Export character schemas
export * from "./schemas/character";
// Export base table schemas (abstract SchemaTable definitions + buildBaseTables factory)
export * from "./schemas/index";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./secrets";
// Export security utilities
export * from "./security";
export * from "./services";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/hook";
export * from "./services/message";
export * from "./services/onboarding-cli";
export * from "./services/onboarding-rpc";
// Export onboarding services
export * from "./services/onboarding-state";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/pairing-migration";
export * from "./services/plugin-hooks";
export {
	getTaskSchedulerAdapter,
	markTaskSchedulerDirty,
	registerTaskSchedulerRuntime,
	startTaskScheduler,
	stopTaskScheduler,
	unregisterTaskSchedulerRuntime,
} from "./services/task-scheduler";
export * from "./services/tool-policy";
export * from "./services/optimized-prompt";
export * from "./services/trajectories";
// Export sessions utilities
export * from "./sessions";
export * from "./settings";
export * from "./trajectory-context";
export * from "./trajectory-utils";
// Export everything from types
export * from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
// Export onboarding types and utilities
export * from "./types/onboarding";
export * from "./types/plugin-manifest";
// Bun can drop these runtime exports when they are only surfaced through the
// ./types barrel, which breaks plugin imports of @elizaos/core.
export * as proto from "./types/proto";
export {
	fromJson,
	type JsonObject,
	type JsonValue,
	toJson,
} from "./types/proto";
// Export utils first to avoid circular dependency issues
export * from "./utils";
/** Single implementation — see `utils/batch-queue/semaphore.ts` (was duplicated on `runtime.ts`). */
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
// Export channel utilities (room/world helpers)
export * from "./utils/channel-utils";
// Export browser-compatible utilities
export * from "./utils/environment";
// Export Node-specific utilities
export * from "./utils/server-health";
// Milady state-dir resolution (MILADY_STATE_DIR → ELIZA_STATE_DIR → ~/.milady)
export * from "./utils/state-dir";
// Export streaming utilities
export * from "./utils/streaming";
// Export validation utilities
export * from "./validation";

// Node-specific exports
export const isBrowser = false;
export const isNode = true;
