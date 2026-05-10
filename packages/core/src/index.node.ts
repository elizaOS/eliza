/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 * Streaming context manager is auto-detected at runtime.
 */

export * from "./actions";
export * from "./api/http-helpers";
export * from "./api/route-helpers";
export * from "./app-registry";
export * from "./app-core-runtime-hooks";
// Export all core modules
export * from "./app-route-plugin-registry";
export * from "./browser-capture-hooks";
export * from "./browser-workspace-hooks";
export * from "./boot-env";
// Export configuration and plugin modules - will be removed once cli cleanup
export * from "./character";
// Export character utilities
export * from "./character-utils";
export * from "./cloud-routing";
// Connection management (ensureConnection/ensureConnections) - standalone batch helpers
export * from "./connection";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/connector-config";
export * from "./connectors/privacy";
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
export { isElizaCloudServiceSelectedInConfig } from "./contracts/cloud-topology";
export {
	isCloudInferenceSelectedInConfig,
	migrateLegacyRuntimeConfig,
	type StylePreset,
} from "./contracts/onboarding";
export {
	DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
	DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
	type DeploymentTargetConfig,
	type LinkedAccountFlagsConfig,
	type ServiceCapability,
	type ServiceRoutingConfig,
} from "./contracts/service-routing";
export * from "./contracts/wallet";
export * from "./database";
export * from "./database/inMemoryAdapter";
export * from "./entities";
export * from "./env-utils";
export {
	roleAction,
	updateRoleAction,
} from "./features/advanced-capabilities/actions/role";
export * from "./features/advanced-memory";
// Export capabilities and plugin creation
export * from "./features/basic-capabilities/index";
export * from "./features/documents/index";
export * from "./mobile-device-bridge-hooks";
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
// Cross-platform messaging triage (MESSAGE, MESSAGE, MESSAGE,
// MESSAGE, MESSAGE, adapters, SendPolicy, TriageService).
// Selective re-export — `MessageParticipant` collides with an unrelated type in
// `types/service-interfaces.ts`; consumers that need the triage-side participant type
// should import it from the package barrel.
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
	messagingTriageActions,
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
export {
	type ActionCatalog,
	type ActionCatalogChild,
	type ActionCatalogEntry,
	type ActionCatalogParent,
	type ActionCatalogWarning,
	type ActionCatalogWarningCode,
	type BuildActionCatalogOptions,
	buildActionCatalog,
	type LocalizedActionExamplePair,
	type LocalizedActionExampleResolver,
	normalizeActionName,
	type RuntimeActionLike,
} from "./runtime/action-catalog";
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export * from "./runtime/cost-table";
export * from "./runtime/execute-planned-tool-call";
export {
	__resetLocalizedExamplesProviderForTests,
	getLocalizedExamplesProvider,
	type LocalizedExamplesProvider,
	type LocalizedExamplesProviderInput,
	registerLocalizedExamplesProvider,
} from "./runtime/localized-examples-provider";
export {
	detectLocaleFromText,
	resolveOwnerLocale,
	type ResolveOwnerLocaleOptions,
	type SupportedLocale,
} from "./runtime/locale-detection";
export * from "./runtime/schema-compat";
export * from "./runtime/sub-planner";
export * from "./runtime/system-prompt";
export * from "./runtime/trajectory-recorder";
// Runtime composition (loadCharacters, createRuntimes, getBasicCapabilitiesSettings, mergeSettingsInto) - node only
export * from "./runtime-composition";
export * from "./runtime-env";
export * from "./runtime-route-context";
// Export character schemas
export * from "./schemas/character";
// Export base table schemas (abstract SchemaTable definitions + buildBaseTables factory)
export * from "./schemas/index";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
export * from "./secrets";
// Export security utilities
export * from "./security";
export * from "./sensitive-request-policy";
export * from "./services";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/evaluator";
export * from "./services/evaluator-priorities";
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
export * from "./services/relationships-graph-builder";
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
export {
	isElizaSettingsDebugEnabled,
	settingsDebugCloudSummary,
} from "./settings-debug";
export { sanitizeSpeechText } from "./spoken-text";
export * from "./testing";
export * from "./trajectory-context";
export * from "./trajectory-utils";
export type { ConnectorAccountCapability, ConnectorAccountRef } from "./types";
// Export everything from types
export * from "./types";
export {
	ConnectorAccountHealth,
	ConnectorAccountPurpose,
	ConnectorAccountRole,
	ConnectorAuthMethod,
} from "./types";
export * from "./types/agentEvent";
export * from "./types/message-service";
// Export onboarding types and utilities
export * from "./types/onboarding";
export * from "./types/plugin-manifest";
export type { JsonObject, JsonValue } from "./types/primitives";
// Export utils first to avoid circular dependency issues
export * from "./utils";
/** Single implementation — see `utils/batch-queue/semaphore.ts` (was duplicated on `runtime.ts`). */
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/buffer";
// Export channel utilities (room/world helpers)
export * from "./utils/channel-utils";
export type {
	ConfirmationDecision,
	ConfirmationStatus,
	RequireConfirmationArgs,
} from "./utils/confirmation";
// Unified two-phase confirmation helper for destructive actions.
export {
	clearPendingConfirmation,
	requireConfirmation,
} from "./utils/confirmation";
// Prompt description compression (parity with Python `compress_prompt_description`)
export * from "./utils/description-compressed-lint";
// Export browser-compatible utilities
export * from "./utils/environment";
export { formatError } from "./utils/format-error";
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
