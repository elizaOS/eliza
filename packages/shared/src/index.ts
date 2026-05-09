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
export * from "./api/route-helpers.js";
export * from "./api/http-helpers.js";

// Added by scripts/refactor/p1-rewrite-app-core-imports.mjs.
// Re-export moved app-core modules so consumers can import the package barrel.
export * from "./config";
export * from "./config/allowed-hosts";
export * from "./config/api-key-prefix-hints";
export * from "./config/app-config";
export * from "./config/boot-config";
export * from "./config/boot-config-react";
export * from "./config/boot-config-store";
export * from "./config/branding";
export * from "./config/cloud-only";
export * from "./config/config";
export * from "./config/config-catalog";
export * from "./config/config-paths";
export * from "./config/env-vars";
export * from "./config/plugin-auto-enable";
export * from "./config/plugin-ui-spec";
export * from "./config/runtime-overrides";
export * from "./config/schema";
export * from "./config/ui-spec";
export * from "./config/wechat-config";
export * from "./config/zod-schema.agent-runtime";
export * from "./config/zod-schema.core";
export * from "./events";
export * from "./onboarding/flow";
export * from "./onboarding/local-agent-token";
export * from "./onboarding/mobile-runtime-mode";
export * from "./onboarding/mobile-runtime-mode.test";
export * from "./onboarding/pre-seed-local-runtime";
export * from "./onboarding/probe-local-agent";
export * from "./onboarding/probe-local-agent.test";
export * from "./onboarding/reload-into-runtime-picker";
export * from "./onboarding/server-target";
export * from "./test-support/process-helpers";
export * from "./test-support/test-helpers";
export * from "./types";
export * from "./utils";
export * from "./utils/asset-url";
export * from "./utils/assistant-text";
export * from "./utils/browser-tab-kit-types";
export * from "./utils/browser-tabs-renderer-registry";
export * from "./utils/character-message-examples";
export * from "./utils/clipboard";
export * from "./utils/cloud-status";
export * from "./utils/desktop-bug-report";
export * from "./utils/desktop-dialogs";
export * from "./utils/desktop-workspace";
export * from "./utils/documents-upload-image";
export * from "./utils/eliza-cloud-model-route";
export * from "./utils/eliza-globals";
export * from "./utils/eliza-root";
export * from "./utils/env";
export * from "./utils/errors";
export * from "./utils/exec-safety";
export * from "./utils/format";
export * from "./utils/globals";
export * from "./utils/labels";
export * from "./utils/log-prefix";
export * from "./utils/name-tokens";
export * from "./utils/namespace-defaults";
export * from "./utils/number-parsing";
export * from "./utils/openExternalUrl";
export * from "./utils/owner-name";
export * from "./utils/rate-limiter";
export * from "./utils/serialise";
export * from "./utils/sql-compat";
export * from "./utils/streaming-text";
export * from "./utils/subscription-auth";
export * from "./utils/trajectory-format";
export * from "./utils/tts-debug";
export * from "./voice";
export * from "./voice/character-voice-config";
export * from "./voice/types";
export * from "./voice/voice-chat-playback";
export * from "./voice/voice-chat-playback.test";
export * from "./voice/voice-chat-recording";
export * from "./voice/voice-chat-types";
