/**
 * @elizaos/shared — Browser-safe code shared between agent and app-core.
 *
 * Public surface: re-exports every module listed in `package.json#exports`,
 * excluding modules that pull in node-only dependencies (figlet heading).
 */

// Leaf modules (no internal collisions)
export * from "./app-hero-art.js";
// Awareness + themes barrels
export * from "./awareness/index.js";
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
  DocumentsConfig,
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
  N8nConfig,
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
  X402Config,
} from "./config/types.js";
export * from "./connector-cred-types.js";
export * from "./connectors.js";
// Contracts barrel — exposes apps/awareness/cloud-topology/config/content-pack/
// drop/inbox/onboarding/permissions/service-routing/verification/wallet.
// `contracts/theme` is intentionally NOT pulled in here; it reaches the public
// surface through `./themes`, which already re-exports the same identifiers.
export * from "./contracts/index.js";
export * from "./dev-settings-banner-style.js";
export * from "./dev-settings-table.js";
// `eliza-core-roles` is intentionally NOT re-exported from this barrel.
// It pulls runtime imports (`logger`, `createUniqueUuid`) from `@elizaos/core`,
// which would drag the entire `@elizaos/core` source graph (plugin-sql,
// transformers, onnxruntime) into every consumer of `@elizaos/shared`.
// Callers that need the vendored role helpers must import them through the
// dedicated subpath: `import { ROLE_RANK } from "@elizaos/shared/eliza-core-roles"`.
export * from "./env-utils.js";
export * from "./format-error.js";
export * from "./onboarding-presets.characters.js";
export * from "./onboarding-presets.js";
export * from "./recent-messages-state.js";
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
export * from "./themes/index.js";
export * from "./type-guards.js";
export * from "./validation-keywords.js";
