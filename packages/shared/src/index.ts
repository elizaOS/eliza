/**
 * @elizaos/shared — Shared code between agent, app-core, and UI packages.
 *
 * Public surface: barrel exports for the shared workspace contract.
 */

export * from "./api/http-helpers.js";
export * from "./api/route-helpers.js";
// Leaf modules (no internal collisions)
export * from "./app-hero-art.js";
// Awareness + themes barrels
export * from "./awareness/index.js";
// Re-export moved app-core modules so consumers can import the package barrel.
export * from "./config/allowed-hosts.js";
export * from "./config/api-key-prefix-hints.js";
export * from "./config/app-config.js";
export * from "./config/app-manifest.js";
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
export * from "./config/env-vars.js";
export * from "./config/plugin-auto-enable.js";
export * from "./config/plugin-manifest.js";
export * from "./config/plugin-ui-spec.js";
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
// Contracts barrel — exposes apps/awareness/cloud-topology/config/content-pack/
// drop/inbox/onboarding/permissions/service-routing/verification/wallet.
// `contracts/theme` is intentionally NOT pulled in here; it reaches the public
// surface through `./themes`, which already re-exports the same identifiers.
export * from "./contracts/index.js";
export {
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "./contracts/service-routing.js";
export * from "./dev-settings-banner-style.js";
export * from "./dev-settings-figlet-heading.js";
export * from "./dev-settings-table.js";
export * from "./env-utils.js";
export * from "./events/index.js";
export * from "./format-error.js";
export * from "./onboarding-presets.characters.js";
export * from "./onboarding-presets.js";
export * from "./platform/is-native-server.js";
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
export * from "./terminal/links.js";
export * from "./terminal/theme.js";
export * from "./test-support/process-helpers.js";
export * from "./test-support/test-helpers.js";
export * from "./themes/index.js";
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
export * from "./utils/labels.js";
export * from "./utils/log-prefix.js";
export * from "./utils/name-tokens.js";
export * from "./utils/namespace-defaults.js";
export * from "./utils/number-parsing.js";
export * from "./utils/owner-name.js";
export * from "./utils/rate-limiter.js";
export * from "./utils/serialise.js";
export * from "./utils/sql-compat.js";
export * from "./utils/streaming-text.js";
export * from "./utils/subscription-auth.js";
export * from "./utils/trajectory-format.js";
export * from "./utils/tts-debug.js";
export * from "./validation-keywords.js";
export * from "./voice.js";
