/**
 * @elizaos/shared — Shared code between agent, app-core, and UI packages.
 *
 * Public surface: barrel exports for the shared workspace contract.
 */

export * from "./api/agent-api-types.js";
export * from "./api/command-transport-types.js";
export * from "./api/http-helpers.js";
export * from "./api/route-helpers.js";
// Leaf modules (no internal collisions)
export * from "./app-hero-art.js";
// Email-classification primitives — canonical two-stage classifier + the
// untrusted-content fence. Dependency-free beyond @elizaos/core; consumed by
// inbox-curation and finance bill-extraction in
// @elizaos/plugin-personal-assistant.
export * from "./apps/index.js";
// Awareness + themes barrels
export * from "./awareness/index.js";
export * from "./character-presets.characters.js";
export * from "./character-presets.js";
// Chat-upload limits — the single source of truth for the attachment caps and
// MIME allowlists enforced by the agent server's validateChatImages and
// mirrored by the UI composer. Both sides import these so they cannot drift.
export * from "./chat-upload-limits.js";
export * from "./cli/parse-duration.js";
// Re-export moved app-core modules so consumers can import the package barrel.
export * from "./config/allowed-hosts.js";
export * from "./config/api-key-prefix-hints.js";
export * from "./config/app-config.js";
export * from "./config/boot-config.js";
// boot-config-react.tsx and branding-react.tsx are not barrel-exported
// from the package root because they pull in React at module load time.
// This keeps node-side benchmark / agent boot paths React-free.
export * from "./config/boot-config-store.js";
export * from "./config/branding.js";
export * from "./config/cloud-only.js";
export * from "./config/config.js";
export * from "./config/config-catalog.js";
export * from "./config/config-paths.js";
export * from "./config/distribution-profile.js";
export * from "./config/env-vars.js";
export * from "./config/plugin-auto-enable.js";
export * from "./config/plugin-ui-spec.js";
export * from "./config/runtime-mode.js";
export * from "./config/runtime-overrides.js";
export * from "./config/schema.js";
export * from "./config/types.eliza.js";
// Config barrel — collides with `contracts/inbox` on `InboxAutoReplyConfig`
// and `InboxTriageRules`. Surface those config-level shapes under aliased
// names; the canonical shapes remain in `./contracts`.
export type {
  AgentBinding,
  AgentCompactionConfig,
  AgentCompactionMemoryFlushConfig,
  AgentCompactionMode,
  AgentConfig,
  AgentContextPruningConfig,
  AgentDefaultsConfig,
  AgentModelConfig,
  AgentModelEntryConfig,
  AgentModelListConfig,
  AgentsConfig,
  ApprovalsConfig,
  AudioConfig,
  AuthConfig,
  AuthProfileConfig,
  BedrockDiscoveryConfig,
  BroadcastConfig,
  BroadcastStrategy,
  BrowserConfig,
  BrowserProfileConfig,
  BrowserSnapshotDefaults,
  CliBackendConfig,
  CloudBackupConfig,
  CloudBridgeConfig,
  CloudConfig,
  CloudContainerDefaults,
  CloudInferenceMode,
  CloudServiceToggles,
  CommandsConfig,
  ConfigFileSnapshot,
  ConfigValidationIssue,
  ConnectorConfig,
  ConnectorFieldValue,
  CronConfig,
  CuaConfig,
  DatabaseConfig,
  DiagnosticsCacheTraceConfig,
  DiagnosticsConfig,
  DiagnosticsOtelConfig,
  DiscoveryConfig,
  DocumentsConfig,
  ElizaConfig,
  EmbeddingConfig,
  EscalationConfig,
  ExecApprovalForwardingConfig,
  ExecApprovalForwardingMode,
  ExecApprovalForwardTarget,
  ExecToolConfig,
  GatewayAuthConfig,
  GatewayAuthMode,
  GatewayBindMode,
  GatewayConfig,
  GatewayControlUiConfig,
  GatewayHttpChatCompletionsConfig,
  GatewayHttpConfig,
  GatewayHttpEndpointsConfig,
  GatewayHttpResponsesConfig,
  GatewayHttpResponsesFilesConfig,
  GatewayHttpResponsesImagesConfig,
  GatewayHttpResponsesPdfConfig,
  GatewayNodesConfig,
  GatewayReloadConfig,
  GatewayReloadMode,
  GatewayRemoteConfig,
  GatewayTailscaleConfig,
  GatewayTailscaleMode,
  GatewayTlsConfig,
  HookConfig,
  HookInstallRecord,
  HookMappingConfig,
  HookMappingMatch,
  HookMappingTransform,
  HooksConfig,
  HooksGmailConfig,
  HooksGmailTailscaleMode,
  InboundDebounceByProvider,
  InboundDebounceConfig,
  // Aliased to avoid collision with the canonical contracts/inbox versions.
  InboxAutoReplyConfig as AgentDefaultsInboxAutoReplyConfig,
  InboxTriageRules as AgentDefaultsInboxTriageRules,
  InternalHookHandlerConfig,
  InternalHooksConfig,
  LinkModelConfig,
  LinkToolsConfig,
  LoggingConfig,
  MdnsDiscoveryConfig,
  MdnsDiscoveryMode,
  MediaToolsConfig,
  MediaUnderstandingAttachmentsConfig,
  MediaUnderstandingCapability,
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
  MediaUnderstandingScopeConfig,
  MediaUnderstandingScopeMatch,
  MediaUnderstandingScopeRule,
  MemoryBackend,
  MemoryCitationsMode,
  MemoryConfig,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdLimitsConfig,
  MemoryQmdSessionConfig,
  MemoryQmdUpdateConfig,
  MemorySearchConfig,
  MessagesConfig,
  ModelApi,
  ModelCompatConfig,
  ModelDefinitionConfig,
  ModelProviderAuthMode,
  ModelProviderConfig,
  ModelsConfig,
  NodeHostBrowserProxyConfig,
  NodeHostConfig,
  OwnerContactEntry,
  OwnerContactsConfig,
  PgliteConfig,
  PluginEntryConfig,
  PluginInstallRecord,
  PluginSlotsConfig,
  PluginsConfig,
  PluginsLoadConfig,
  PostgresCredentials,
  QueueConfig,
  QueueDropPolicy,
  QueueMode,
  QueueModeByProvider,
  RegistryEndpoint,
  RolesConfig,
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
  SkillConfig,
  SkillsConfig,
  SkillsInstallConfig,
  SkillsLoadConfig,
  ToolsConfig,
  TtsAutoMode,
  TtsConfig,
  TtsMode,
  TtsModelOverrideConfig,
  TtsProvider,
  UpdateConfig,
  WebConfig,
  WebReconnectConfig,
  WorkflowConfig,
  X402Config,
} from "./config/types.js";
export * from "./config/ui-spec.js";
export * from "./config/wechat-config.js";
export * from "./config/zod-schema.agent-runtime.js";
export * from "./config/zod-schema.core.js";
export * from "./connector-cred-types.js";
export * from "./connectors.js";
export {
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderFamily,
  getFirstRunProviderOption,
  getFirstRunProviderSignalEnvKeys,
  getStoredFirstRunProviderId,
  normalizeFirstRunProviderId,
  sortFirstRunProviders,
} from "./contracts/first-run-options.js";
// Contracts barrel — exposes apps/awareness/cloud-topology/config/content-pack/
// drop/inbox/first-run/permissions/service-routing/verification/wallet.
// `contracts/theme` is intentionally NOT pulled in here; it reaches the public
// surface through `./themes`, which already re-exports the same identifiers.
export * from "./contracts/index.js";
export { PutCuratedSkillSourceRequestSchema } from "./contracts/plugin-routes.js";
export {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "./contracts/service-routing.js";
export {
  PostMarketplaceInstallRequestSchema,
  PostMarketplaceUninstallRequestSchema,
  PostSkillAcknowledgeRequestSchema,
  PostSkillCatalogInstallRequestSchema,
  PostSkillCatalogUninstallRequestSchema,
  PostSkillCreateRequestSchema,
  PutSkillSourceRequestSchema,
} from "./contracts/skills-routes.js";
// themes/ runtime (presets + apply engine) moved to @elizaos/ui/themes in
// Phase 5B (shared shrink). The theme TYPE contract stays here because
// `contracts/content-pack` references `ThemeDefinition`. Consumers should
// import the runtime helpers (`ELIZA_DEFAULT_THEME`, `applyThemeToDocument`,
// etc.) from `@elizaos/ui`.
export * from "./contracts/theme.js";
// db types — canonical handles for the runtime Drizzle database so consumers
// don't reverse-import the plugin-sql package for type-only uses.
export type { DrizzleDatabase } from "./db/drizzle-database.js";
export * from "./dev-settings-banner-style.js";
export * from "./dev-settings-figlet-heading.js";
export * from "./dev-settings-table.js";
// elizacloud helpers — pure utilities + config-driven server helpers used by
// app-core and the agent so they don't reverse-import from plugin-elizacloud.
export * from "./elizacloud/index.js";
export * from "./email-classification/index.js";
export * from "./env-utils.js";
export * from "./error-classification.js";
export * from "./events/index.js";
export * from "./format-error.js";
// Knowledge-graph primitives — canonical Entity/Relationship types + the
// identity-merge engine. Dependency-free; the DB-backed stores stay in
// @elizaos/plugin-personal-assistant.
export * from "./knowledge-graph/index.js";
// LifeOps service constants — canonical constant tables for the
// personal-assistant scheduled-task / reminder / connector pipelines. Depends
// only on the LifeOps contract types; consumed by
// @elizaos/plugin-personal-assistant via a thin re-export shim.
export * from "./lifeops-constants/index.js";
// LifeOps normalize/validation primitives — pure input normalization helpers,
// time-zone helpers, and the status-carrying LifeOpsServiceError. Depends only
// on @elizaos/core and the LifeOps contract types/constants; consumed by
// @elizaos/plugin-personal-assistant via thin re-export shims.
export * from "./lifeops-normalize/index.js";
// Local-inference shared subset (types, paths, routing-preferences, verify).
// Server runtime (KV cache, llama-server lifecycle, etc.) stays in @elizaos/app-core.
export * from "./local-inference/index.js";
export * from "./loopback-trust.js";
export * from "./meetings.js";
export * from "./platform/aosp-user-agent.js";
export * from "./platform/is-native-server.js";
export * from "./process-guards.js";
export * from "./recent-messages-state.js";
export * from "./registry-host.js";
export * from "./restart.js";
export * from "./runtime-env.js";
export * from "./self-edit.js";
// Settings debug helpers
export {
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "./settings-debug.js";
export * from "./spoken-text.js";
export * from "./terminal/links.js";
export * from "./terminal/theme.js";
export * from "./transcripts.js";
export * from "./type-guards.js";
export * from "./types/index.js";
export * from "./utils/asset-url.js";
export * from "./utils/assistant-text.js";
export * from "./utils/browser-tab-kit-types.js";
export * from "./utils/browser-tabs-renderer-registry.js";
export * from "./utils/character-message-examples.js";
export * from "./utils/cloud-status.js";
export * from "./utils/documents-upload-image.js";
export * from "./utils/eliza-cloud-model-route.js";
export * from "./utils/eliza-globals.js";
export * from "./utils/eliza-root.js";
export * from "./utils/env.js";
export * from "./utils/errors.js";
export * from "./utils/exec-safety.js";
export * from "./utils/format.js";
export * from "./utils/host-capabilities.js";
export * from "./utils/labels.js";
export * from "./utils/log-prefix.js";
export * from "./utils/name-tokens.js";
export * from "./utils/namespace-defaults.js";
export * from "./utils/number-parsing.js";
export { parseClampedInteger } from "./utils/number-parsing.js";
export * from "./utils/owner-name.js";
export * from "./utils/permission-deep-links.js";
export * from "./utils/rate-limiter.js";
export * from "./utils/serialise.js";
export * from "./utils/sql-compat.js";
export * from "./utils/streaming-text.js";
export * from "./utils/subscription-auth.js";
export * from "./utils/trajectory-format.js";
export * from "./utils/tts-debug.js";
export * from "./validation-keywords.js";
export * from "./view-hero-art.js";
export * from "./views/view-interact-protocol.js";
export * from "./voice/first-sentence-snip.js";
export * from "./voice/voice-cancellation-token.js";
export * from "./voice.js";
export * from "./voice-wer.js";
export * from "./wallet/market-overview.js";
