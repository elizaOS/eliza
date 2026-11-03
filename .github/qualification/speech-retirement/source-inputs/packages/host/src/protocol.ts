/** Shared host configuration and HTTP contracts; safe to import in a browser. */
export * from "./api/app-route-plugin-registry.js";
export * from "./api/http-plugin.js";
export * from "./api/http-plugin-runtime.js";
export * from "./api/route-helpers.js";
export * from "./api/runtime-route-context.js";
export * from "./boot-env.js";
export * from "./character-presets.characters.js";

export {
  buildElizaCharacterCatalog,
  CHARACTER_PRESET_META,
  CHARACTER_PRESETS,
  getDefaultAgentName,
  getDefaultStylePreset,
  getPresetNameMap,
  getStylePresets,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
  resolveStylePresetByName,
  STYLE_PRESETS,
  setDefaultAgentName,
} from "./character-presets.js";
export * from "./character-presets.shared.js";
export * from "./checkout/index.js";
export * from "./config/allowed-hosts.js";
export * from "./config/api-key-prefix-hints.js";
export * from "./config/app-config.js";
export {
  type AppBootConfig,
  type BundledVrmAsset,
  type CharacterAssetEntry,
  type CharacterCatalogData,
  type ClientMiddleware,
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  getBootConfigEnvAliases as getAppBootConfigEnvAliases,
  type InjectedCharacterEntry,
  type ResolvedCharacterAsset,
  type ResolvedInjectedCharacter,
  resolveAliasedEnvValue as resolveAppAliasedEnvValue,
  resolveCharacterCatalog,
  setBootConfig,
} from "./config/boot-config-store.js";
export * from "./config/brand-env-aliases.js";
export * from "./config/branding.js";
export * from "./config/cloud-only.js";
export * from "./config/config-catalog.js";
export * from "./config/distribution-profile.js";
export * from "./config/first-run-connectors.js";
export * from "./config/plugin-auto-enable-engine.js";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "./config/plugin-ui-spec.js";
export * from "./config/public-endpoints.js";
export * from "./config/runtime-mode.js";
export * from "./config/schema.js";
export type {
  AgentDefaultsConfig,
  AgentModelEntryConfig,
  AgentModelListConfig,
  CliBackendConfig,
  EscalationConfig,
  InboxAutoReplyConfig as AgentInboxAutoReplyConfig,
  InboxTriageRules as AgentInboxTriageRules,
  OwnerContactEntry,
  OwnerContactsConfig,
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./config/types.agent-defaults.js";
export * from "./config/types.agents.js";
export type {
  ApprovalsConfig,
  AuthConfig,
  AuthProfileConfig,
  BedrockDiscoveryConfig,
  BrowserConfig,
  BrowserProfileConfig,
  BrowserSnapshotDefaults,
  CloudBackupConfig,
  CloudBridgeConfig,
  CloudConfig,
  CloudContainerDefaults,
  CloudInferenceMode,
  CloudServiceToggles,
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
  DocumentsConfig,
  ElizaConfig,
  EmbeddingConfig,
  ExecApprovalForwardingConfig,
  ExecApprovalForwardingMode,
  ExecApprovalForwardTarget,
  LoggingConfig,
  MemoryBackend,
  MemoryCitationsMode,
  MemoryConfig as AppMemoryConfig,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdLimitsConfig,
  MemoryQmdSessionConfig,
  MemoryQmdUpdateConfig,
  ModelApi,
  ModelCompatConfig,
  ModelDefinitionConfig,
  ModelProviderAuthMode,
  ModelProviderConfig,
  ModelsConfig,
  NodeHostBrowserProxyConfig,
  NodeHostConfig,
  PgliteConfig,
  PluginEntryConfig,
  PluginInstallRecord,
  PluginSlotsConfig,
  PluginsConfig,
  PluginsLoadConfig,
  PostgresCredentials,
  RegistryEndpoint,
  SkillConfig,
  SkillsConfig,
  SkillsInstallConfig,
  SkillsLoadConfig,
  UpdateConfig,
  WebConfig,
  WebReconnectConfig,
  WorkflowConfig,
  X402Config as AppX402Config,
} from "./config/types.eliza.js";
export * from "./config/types.gateway.js";
export * from "./config/types.hooks.js";
export * from "./config/types.messages.js";
export * from "./config/types.tools.js";
export type {
  ActionConfirm,
  ActionOnError,
  ActionOnSuccess,
  AndVisibility,
  AuthState,
  AuthVisibility,
  BuiltinValidator,
  CondExpr,
  DynamicProp,
  NotVisibility,
  OrVisibility,
  PatchOp as ConfigUiPatchOp,
  PathVisibility,
  RepeatConfig,
  UIStreamConfig,
  UiAction,
  UiComponentType,
  UiElement,
  UiEventBindings,
  UiRenderContext,
  UiSpec,
  UiSpecValidationCheck,
  UiSpecValidationConfig,
  UiSpecVisibilityCondition,
  VisibilityOperator,
} from "./config/ui-spec.js";
export * from "./config/zod-schema.core.js";
export * from "./contracts/cloud-topology.js";
export type {
  CharacterFailureTemplates,
  CloudProviderOption,
  FirstRunCloudManagedConnection,
  FirstRunConnection,
  FirstRunConnectorConfig,
  FirstRunCredentialInputs,
  FirstRunCredentialPersistencePlan,
  FirstRunLlmPersistenceSelection,
  FirstRunLocalProviderConnection,
  FirstRunLocalProviderId,
  FirstRunOptions,
  FirstRunProviderAuthMode,
  FirstRunProviderFamily,
  FirstRunProviderGroup,
  FirstRunProviderId,
  FirstRunRemoteProviderConnection,
  InventoryProviderOption,
  MessageExample as FirstRunMessageExample,
  MessageExampleContent,
  ModelOption,
  OpenRouterModelOption,
  ProviderOption,
  RpcProviderOption,
  StoredSubscriptionProviderId,
  StylePreset,
  SubscriptionCredentialSource,
  SubscriptionProviderSelectionId,
  SubscriptionProviderStatus,
  SubscriptionStatusResponse,
} from "./contracts/first-run-options.js";
export {
  DIRECT_ACCOUNT_PROVIDER_BY_FIRST_RUN_PROVIDER,
  deriveFirstRunCredentialPersistencePlan,
  FIRST_RUN_CLOUD_PROVIDER_OPTIONS,
  FIRST_RUN_PROVIDER_CATALOG,
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderFamily,
  getFirstRunProviderOption,
  getFirstRunProviderSignalEnvKeys,
  getProviderOptions,
  getStoredFirstRunProviderId,
  getStoredSubscriptionProvider,
  getStoredSubscriptionProviderForRequest,
  getSubscriptionProviderFamily,
  hasExplicitCanonicalRuntimeConfig,
  inferCompatibilityFirstRunConnection,
  inferFirstRunConnectionFromConfig,
  isCloudInferenceSelectedInConfig,
  isCloudManagedConnection,
  isFirstRunConnectionComplete,
  isLocalOnlyInferenceInConfig,
  isLocalProviderConnection,
  isRemoteProviderConnection,
  isSubscriptionProviderSelectionId,
  migrateLegacyRuntimeConfig,
  migrateRetiredSubscriptionChatRoute,
  normalizeFirstRunCredentialInputs,
  normalizeFirstRunProviderId,
  normalizePersistedFirstRunConnection,
  normalizeSubscriptionProviderSelectionId,
  readFirstRunEnvSecret,
  readFirstRunEnvString,
  registerProviderOption,
  requiresAdditionalRuntimeProvider,
  resolveDeploymentTargetInConfig,
  resolveLinkedAccountsInConfig,
  resolveServiceRoutingInConfig,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  sortFirstRunProviders,
  stripFirstRunConnectionSecrets,
} from "./contracts/first-run-options.js";
export * from "./contracts/first-run-routes.js";
export * from "./contracts/service-routing.js";
export * from "./media-provider.js";
export type {
  BuildVariant,
  NativeLibraryCandidate,
  NativeLibraryPolicyOptions,
} from "./native-platform.js";
export * from "./os-intent/dedupe.js";
export {
  type AuthState as OsIntentAuthState,
  type MicPermissionState,
  type RoutingContext,
  routeIntent,
} from "./os-intent/router.js";
export * from "./passive-connectors.js";
export {
  isAospElizaUserAgent,
  isElizaOS,
  isNativeServerPlatform,
  userAgentHasElizaOSMarker,
} from "./platform.js";
export * from "./restart.js";
export {
  API_EXPOSE_PORT_KEYS,
  createSelfApiRequestHeaders,
  DEFAULT_DESKTOP_API_PORT,
  DEFAULT_DESKTOP_UI_PORT,
  DEFAULT_SERVER_ONLY_PORT,
  ELIZA_RUNTIME_ENV_KEYS,
  type ElizaRuntimeEnv,
  firstWinningEnvString,
  isAndroidMobile,
  isDevApiWatchEnabled,
  isIosMobile,
  isMobilePlatform,
  isNullOriginAllowed,
  type PortPreferenceResolution,
  type ResolvedApiSecurityConfig,
  type ResolvedRuntimePorts,
  type RuntimeEnvRecord,
  resolveAllowedHosts,
  resolveAllowedOrigins,
  resolveAllowNullOrigin,
  resolveApiAllowedHosts,
  resolveApiAllowedOrigins,
  resolveApiBindHost,
  resolveApiExposePort,
  resolveApiSecurityConfig,
  resolveApiToken,
  resolveConfiguredApiToken,
  resolveDesktopApiPort,
  resolveDesktopApiPortPreference,
  resolveDesktopUiPort,
  resolveDesktopUiPortPreference,
  resolveDisableAutoApiToken,
  resolveElizaRuntimeEnv,
  resolvePlatform,
  resolveRuntimePorts,
  resolveSelfApiBaseUrl,
  resolveSelfApiCredential,
  resolveServerOnlyPort,
  resolveSingleProcessPort,
  resolveUiPort,
  setApiToken,
  syncResolvedApiPort,
} from "./runtime-env.js";
export * from "./settings-debug.js";
export * from "./utils/eliza-globals.js";
export * from "./utils/env.js";
export * from "./voice.js";
export * from "./workbench.js";
