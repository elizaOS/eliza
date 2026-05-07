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
	factExtractorEvaluator,
	skillExtractionEvaluator,
	skillRefinementEvaluator,
} from "./features/advanced-capabilities/evaluators/index";
export * from "./features/advanced-memory";
// Export capabilities and plugin creation
export * from "./features/basic-capabilities/index";
export type {
	DraftRecord,
	DraftRequest,
	ListOptions,
	ManageOperation,
	ManageResult,
	MessageAdapter,
	MessageAdapterCapabilities,
	MessageRef,
	MessageSource,
	ScoreContext,
	SearchMessagesFilters,
	SendPolicy,
	SuggestedAction,
	TriageOptions,
	TriagePriority,
	TriageScore,
} from "./features/messaging/triage";
// Cross-platform messaging triage (TRIAGE_MESSAGES, SEARCH_MESSAGES, MANAGE_MESSAGE,
// SCHEDULE_DRAFT_SEND, RESPOND_TO_MESSAGE, adapters, SendPolicy, TriageService).
// Selective re-export — `MessageParticipant` collides with an unrelated type in
// `types/service-interfaces.ts`; consumers that need the triage-side participant type
// import it directly from "@elizaos/core/features/messaging/triage".
export {
	__resetDefaultMessageRefStoreForTests,
	__resetDefaultTriageServiceForTests,
	BaseMessageAdapter,
	DiscordMessageAdapter,
	draftFollowupAction,
	draftReplyAction,
	GmailMessageAdapter,
	getDefaultMessageRefStore,
	getDefaultTriageService,
	getSendPolicy,
	IMessageMessageAdapter,
	listInboxAction,
	MessageRefStore,
	manageMessageAction,
	NotYetImplementedError,
	rankScored,
	registerSendPolicy,
	resetMissingServiceWarning,
	resolveContactWeight,
	respondToMessageAction,
	SignalMessageAdapter,
	scheduleDraftSendAction,
	scoreMessage,
	scoreMessages,
	searchMessagesAction,
	sendDraftAction,
	TelegramMessageAdapter,
	TwitterMessageAdapter,
	triageMessagesAction,
	WhatsappMessageAdapter,
} from "./features/messaging/triage";
export { PluginManagerService } from "./features/plugin-manager/services/pluginManagerService.ts";
export {
	SECRETS_SERVICE_TYPE,
	type SecretsManagerPluginConfig,
	secretsManagerPlugin,
} from "./features/secrets/index.ts";
// Export generated action/provider/evaluator specs from centralized prompts
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export * from "./lifeops-passive-connectors";
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
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export * from "./runtime/cost-table";
export * from "./runtime/execute-planned-tool-call";
export * from "./runtime/schema-compat";
export * from "./runtime/sub-planner";
export * from "./runtime/system-prompt";
export * from "./runtime/trajectory-recorder";
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
export * from "./services/optimized-prompt";
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
export type { JsonObject, JsonValue } from "./types/proto";
// Bun can drop these runtime exports when they are only surfaced through the
// ./types barrel, which breaks plugin imports of @elizaos/core.
export * as proto from "./types/proto";
// Export utils first to avoid circular dependency issues
export * from "./utils";
/** Single implementation — see `utils/batch-queue/semaphore.ts` (was duplicated on `runtime.ts`). */
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
// Export channel utilities (room/world helpers)
export * from "./utils/channel-utils";
// Prompt description compression (parity with Python `compress_prompt_description`)
export * from "./utils/description-compressed-lint";
// Export browser-compatible utilities
export * from "./utils/environment";
export * from "./utils/prompt-compression";
// Export Node-specific utilities
export * from "./utils/server-health";
// Eliza state-dir resolution (ELIZA_STATE_DIR → ~/.eliza)
export * from "./utils/state-dir";
// Export streaming utilities
export * from "./utils/streaming";
// Export validation utilities
export * from "./validation";

// Node-specific exports
export const isBrowser = false;
export const isNode = true;
