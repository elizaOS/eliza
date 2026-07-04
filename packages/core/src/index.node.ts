/**
 * Node.js-specific entry point for @elizaos/core
 *
 * This file exports all modules including Node.js-specific functionality.
 * This is the full API surface of the core package.
 * Streaming context manager is auto-detected at runtime.
 */

export * from "./access-context";
export * from "./access-control/filter";
// Export all core modules
export * from "./account-pool-bridge";
export * from "./action-names";
export * from "./actions";
export * from "./activity-plaintext";
export * from "./api/http-helpers";
export * from "./api/route-helpers";
export * from "./app-registry";
export * from "./app-route-plugin-registry";
export * from "./boot-env";
export * from "./build-variant";
export * from "./capabilities";
// Export configuration and plugin modules - will be removed once cli cleanup
export * from "./character";
// Export character utilities
export * from "./character-utils";
export * from "./cloud-auth-service";
export * from "./cloud-routing";
// Connection management (ensureConnection/ensureConnections) - standalone batch helpers
export * from "./connection";
export * from "./connectors";
export * from "./connectors/account-manager";
export * from "./connectors/attachments";
export * from "./connectors/connector-config";
export * from "./connectors/oauth-role";
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
	SECRET_KEY_ALIASES,
} from "./constants";
export { isElizaCloudServiceSelectedInConfig } from "./contracts/cloud-topology";
export {
	isCloudInferenceSelectedInConfig,
	migrateLegacyRuntimeConfig,
	type StylePreset,
} from "./contracts/first-run-options";
export {
	DEFAULT_CEREBRAS_TEXT_MODEL,
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
export * from "./errors";
export {
	roleAction,
	updateRoleAction,
} from "./features/advanced-capabilities/actions/role";
export * from "./features/advanced-memory";
export {
	AUTONOMY_SERVICE_TYPE,
	AUTONOMY_TASK_NAME,
	AUTONOMY_TASK_TAGS,
	AutonomyService,
} from "./features/autonomy";
// Export capabilities and plugin creation
export * from "./features/basic-capabilities/index";
export * from "./features/credential-proxy/index.ts";
export * from "./features/documents/index";
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
	draftFollowupAction,
	draftReplyAction,
	getDefaultMessageRefStore,
	getDefaultTriageService,
	getSendPolicy,
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
	scheduleDraftSendAction,
	scoreMessage,
	scoreMessages,
	searchMessagesAction,
	sendDraftAction,
	triageMessagesAction,
} from "./features/messaging/triage";
// OAuth provider contract (the canonical provider identifiers the atomic OAuth
// actions accept). Exported so cloud-shared can enforce core ⊆ cloud-registry.
export {
	CONNECTOR_NATIVE_OAUTH_PROVIDERS,
	OAUTH_PROVIDERS,
	type OAuthProvider,
} from "./features/oauth/types.ts";
export { paymentsPlugin } from "./features/payments/index.ts";
export { PluginManagerService } from "./features/plugin-manager/services/pluginManagerService.ts";
export {
	SECRETS_SERVICE_TYPE,
	type SecretsManagerPluginConfig,
	secretsManagerPlugin,
} from "./features/secrets/index.ts";
export * from "./features/sub-agent-credentials/index";
export * from "./features/subscription-auth/index.ts";
// Export generated action/provider/evaluator specs from centralized prompts
export * from "./generated/action-docs";
export * from "./generated/spec-helpers";
export * from "./identity-clusters";
export * from "./inference-timing";
export * from "./lifeops-passive-connectors";
export * from "./logger";
// Export markdown utilities
export * from "./markdown";
// Export media utilities
export * from "./media";
export * from "./memory";
export * from "./messaging/interactions";
export * from "./mobile-device-bridge-service";
export * from "./model-gateway";
export * from "./name-tokens";
// Export network utilities (SSRF protection, secure fetch)
export * from "./network";
export { getOptimizationRootDir } from "./optimization-root-dir";
export * from "./plugin";
export * from "./plugins";
export * from "./prompts";
// Export recent-errors provider (#12263)
export * from "./providers/recent-errors";
// Export setup providers
export * from "./providers/setup-progress";
// Export skill eligibility provider
export * from "./providers/skill-eligibility";
// Provisioning (migrations, agent/entity/room, embedding dimension) - node only
export * from "./provisioning";
export * from "./recent-messages-state";
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
export { warnOnUnmatchedActionRolePolicyKeys } from "./runtime/action-role-policy";
export * from "./runtime/builtin-field-evaluators";
export {
	__resetCandidateActionBackstopRulesForTests,
	type CandidateActionBackstopRule,
	getCandidateActionBackstopRules,
	registerCandidateActionBackstopRule,
} from "./runtime/candidate-action-backstop";
export * from "./runtime/cleanup-scope";
export * from "./runtime/context-gates";
export * from "./runtime/context-registry";
export * from "./runtime/conversation-compaction-hook";
export {
	__resetDirectMessageHooksForTests,
	type DirectMessageHook,
	type DirectMessageHookInput,
	getDirectMessageHooks,
	registerDirectMessageHook,
	runDirectMessageHooks,
	unregisterDirectMessageHook,
} from "./runtime/direct-message-hook";
export * from "./runtime/execute-planned-tool-call";
export {
	detectLocaleFromText,
	type ResolveOwnerLocaleOptions,
	resolveOwnerLocale,
	type SupportedLocale,
} from "./runtime/locale-detection";
export {
	__resetLocalizedExamplesProviderForTests,
	getLocalizedExamplesProvider,
	type LocalizedExamplesProvider,
	type LocalizedExamplesProviderInput,
	registerLocalizedExamplesProvider,
} from "./runtime/localized-examples-provider";
export {
	getMessageHandlerReply,
	type MessageHandlerRoute,
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
	SIMPLE_CONTEXT_ID,
	type V5MessageHandlerOutput,
} from "./runtime/message-handler";
export * from "./runtime/response-grammar";
export * from "./runtime/response-handler-evaluators";
export * from "./runtime/response-handler-field-evaluator";
export * from "./runtime/response-handler-field-registry";
export * from "./runtime/rlm";
export * from "./runtime/room-handler-queue";
export * from "./runtime/schema-compat";
export * from "./runtime/shortcut-registry";
export * from "./runtime/sub-planner";
export * from "./runtime/system-prompt";
export * from "./runtime/trajectory-recorder";
export * from "./runtime/turn-controller";
export {
	type CallModelWithValidationOptions,
	type CallModelWithValidationResult,
	callModelWithValidation,
	DEFAULT_REMOTE_REROLL_BUDGET,
	getProviderForModelType,
	type ParseAndValidateResult,
	parseAndValidate,
	rerollBudgetCeilingFromSetting,
	SchemaValidationFailedError,
} from "./runtime/validated-model-call";
// Runtime composition (loadCharacters, createRuntimes, getBasicCapabilitiesSettings, mergeSettingsInto) - node only
export * from "./runtime-composition";
export * from "./runtime-env";
export * from "./runtime-route-context";
export {
	_setAppBundleRootForTests,
	assertDlopenPathAllowed,
	isPathInsideAppBundle,
} from "./sandbox/dlopen-gate";
export * from "./sandbox-policy";
// Export character schemas
export * from "./schemas/character";
// Export base table schemas (abstract SchemaTable definitions + buildBaseTables factory)
export * from "./schemas/index";
export { type BaseTables, buildBaseTables } from "./schemas/index";
export * from "./search";
// Export security utilities
export * from "./security";
export * from "./security/secret-swap";
export * from "./sensitive-request-policy";
export * from "./sensitive-requests";
export * from "./services";
export * from "./services/agent-event-bridge";
export * from "./services/agentEvent";
export * from "./services/approval";
export * from "./services/channel-topics";
export * from "./services/evaluator";
export * from "./services/evaluator-priorities";
export * from "./services/hook";
export * from "./services/message";
export {
	CODING_DELEGATION_ACTION_TAGS,
	findCodingDelegationActionName,
	hasActionTags,
	LEGACY_CODING_DELEGATION_ACTION_NAMES,
	normalizeActionIdentifier,
} from "./services/message/direct-action-heuristics";
export * from "./services/notification";
export * from "./services/optimized-prompt";
export { resolveOptimizedPromptForRuntime } from "./services/optimized-prompt-resolver";
export * from "./services/pairing";
export * from "./services/pairing-integration";
export * from "./services/relationships-graph-builder";
export * from "./services/runtime-capability-service";
export * from "./services/setup-cli";
export * from "./services/setup-rpc";
// Export setup services
export * from "./services/setup-state";
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
export * from "./services/triggerScheduling";
// Export sessions utilities
export * from "./sessions";
export * from "./settings";
export {
	isElizaSettingsDebugEnabled,
	sanitizeForSettingsDebug,
	settingsDebugCloudSummary,
} from "./settings-debug";
export { sanitizeSpeechText } from "./spoken-text";
export * from "./target-sources";
export {
	availableProviderNames,
	isLiveTestEnabled,
	type LiveProviderConfig,
	type LiveProviderName,
	requireLiveProvider,
	selectLiveProvider,
} from "./testing/live-provider";
export * from "./trajectory-context";
export * from "./trajectory-utils";
export * from "./tunnel-service";
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
export * from "./types/notification";
export * from "./types/plugin-manifest";
export type { JsonObject, JsonValue, ProcessEnvLike } from "./types/primitives";
// Export setup types and utilities
export * from "./types/setup";
export type {
	EnabledViewKinds,
	ViewKind,
	ViewKindBearer,
} from "./types/view-kind";
export {
	isAlwaysOnViewKind,
	isViewKindEnabled,
	isViewVisible,
	resolveViewKind,
	VIEW_KIND_META,
	VIEW_KINDS,
} from "./types/view-kind";
// Export utils first to avoid circular dependency issues
export * from "./utils";
export {
	addHeader,
	composePromptFromState,
	parseKeyValueXml,
	parseToonKeyValue,
} from "./utils";
/** Single implementation — see `utils/batch-queue/semaphore.ts` (was duplicated on `runtime.ts`). */
export { Semaphore } from "./utils/batch-queue/semaphore.js";
export * from "./utils/boolean";
export * from "./utils/buffer";
// Export channel utilities (room/world helpers)
export * from "./utils/channel-utils";
export type {
	ConfirmationDecision,
	ConfirmationStatus,
	DestructiveConfirmationGateResult,
	RequireConfirmationArgs,
} from "./utils/confirmation";
// Unified two-phase confirmation helper for destructive actions.
export {
	clearPendingConfirmation,
	gateDestructiveConfirmation,
	llmConfirmedFlagIsAuthoritative,
	requireConfirmation,
} from "./utils/confirmation";
// Prompt description compression (parity with Python `compress_prompt_description`)
export * from "./utils/description-compressed-lint";
export * from "./utils/deterministic";
// Export browser-compatible utilities
export * from "./utils/environment";
export { getEnv } from "./utils/environment";
export { formatError } from "./utils/format-error";
/** Single-lane local inference scheduling: interactive-over-background gate + device-class background budgets (#11914). */
export * from "./utils/inference-priority-gate";
// Export Node-specific utilities
export * from "./utils/prompt-compression";
// Canonical env-var reader with legacy-alias back-compat
export * from "./utils/read-env";
// Canonical runtime-setting → env resolver (per-agent setting first, then env)
export * from "./utils/resolve-setting";
export * from "./utils/server-health";
// Eliza state-dir resolution (ELIZA_STATE_DIR → XDG state home)
export * from "./utils/state-dir";
// Export streaming utilities
export * from "./utils/streaming";
export { ResponseSkeletonStreamExtractor } from "./utils/streaming";
// User-chosen workspace folder persisted in <stateDir>/workspace-folder.json,
// shared between the Electrobun renderer (writes via desktop RPC) and the
// agent runtime (reads at boot to seed ELIZA_WORKSPACE_DIR for store builds).
export * from "./utils/workspace-folder-config";
// Export validation utilities
export * from "./validation";

// Node-specific exports
export const isBrowser = false;
export const isNode = true;
