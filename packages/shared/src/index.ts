/**
 * @elizaos/shared — Browser-safe code shared between agent and app-core.
 *
 * Public surface: re-exports every module listed in `package.json#exports`,
 * excluding modules that pull in node-only dependencies (figlet heading).
 */

// Leaf modules (no internal collisions)
export * from "./app-hero-art";
// Awareness + themes barrels
export * from "./awareness";
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
  KnowledgeConfig,
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
} from "./config/types";
export * from "./connectors";
// Contracts barrel — exposes apps/awareness/cloud-topology/config/content-pack/
// drop/inbox/onboarding/permissions/service-routing/verification/wallet.
// `contracts/theme` is intentionally NOT pulled in here; it reaches the public
// surface through `./themes`, which already re-exports the same identifiers.
export * from "./contracts";
export * from "./dev-settings-banner-style";
export * from "./dev-settings-table";
export type {
  ConnectorAdminWhitelist,
  RoleCheckResult,
  RoleGrantSource,
  RoleName,
  RolesConfig as ElizaCoreRolesConfig,
  RolesWorldMetadata,
  ServerOwnershipState,
} from "./eliza-core-roles";
// `eliza-core-roles` defines its own `RolesConfig` that overlaps with the
// `RolesConfig` re-exported from `@elizaos/core` via `./config`. Skip the
// duplicate name here — callers needing the vendored role helpers should use
// the named exports below.
export {
  canModifyRole,
  checkSenderPrivateAccess,
  checkSenderRole,
  findWorldsForOwner,
  getConfiguredOwnerEntityIds,
  getConnectorAdminWhitelist,
  getEntityRole,
  getLiveEntityMetadataFromMessage,
  getUserServerRole,
  hasConfiguredCanonicalOwner,
  matchEntityToConnectorAdminWhitelist,
  normalizeRole,
  ROLE_RANK,
  resolveCanonicalOwnerId,
  resolveCanonicalOwnerIdForMessage,
  resolveEntityRole,
  resolveWorldForMessage,
  setConnectorAdminWhitelist,
  setEntityRole,
} from "./eliza-core-roles";
export * from "./env-utils";
export * from "./onboarding-presets";
export * from "./onboarding-presets.characters";
export * from "./recent-messages-state";
export * from "./restart";
export * from "./runtime-env";
// Settings debug helpers
export {
  isElizaSettingsDebugEnabled,
  sanitizeForSettingsDebug,
  settingsDebugCloudSummary,
} from "./settings-debug";
export * from "./spoken-text";
export * from "./themes";
export * from "./type-guards";
export * from "./validation-keywords";
