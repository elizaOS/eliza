// Stylesheets live in `./styles.ts` (`@elizaos/ui/styles`) so the barrel can be
// imported by Node-side plugin loaders without forcing a CSS evaluation
// (Node refuses ".css" extensions). Renderers must opt-in explicitly.

export * from "./App";
export type {
  AppLaunchDiagnostic,
  AppLaunchDiagnosticSeverity,
  AppLaunchResult,
  AppRunActionResult,
  AppRunAwaySummary,
  AppRunCapabilityAvailability,
  AppRunEvent,
  AppRunEventKind,
  AppRunEventSeverity,
  AppRunHealth,
  AppRunHealthDetails,
  AppRunHealthFacet,
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
  AppSessionActionResult,
  AppSessionActivityItem,
  AppSessionControlAction,
  AppSessionFeature,
  AppSessionJsonValue,
  AppSessionMode,
  AppSessionRecommendation,
  AppSessionState,
  AppStopResult,
  AppViewerAuthMessage,
  ConnectorConfig,
  InstalledAppInfo,
  TradePermissionMode,
} from "./api";
export * from "./api";
export * from "./api/android-native-agent-transport";
// === Phase 3A: barrel-promoted from api/ios-local-agent-transport ===
export * from "./api/ios-local-agent-transport";
export * from "./app-shell-components";
export * from "./app-shell-registry";
export { registerAppShellPage } from "./app-shell-registry";
export * from "./avatar-runtime/index";
export * from "./backgrounds/index";
export * from "./bridge/index";
export * from "./character-catalog";
export {
  DEFAULT_ELIZA_CHARACTER_ASSET,
  getCharacterAsset,
  getCharacterAssets,
  getInjectedCharacter,
  getInjectedCharacters,
} from "./character-catalog";
export * from "./chat/index";
export * from "./companion/index";
export type {
  DocumentImageCompressionPlatform,
  DocumentImageUploadFile,
} from "./components";
export {
  autoLabel,
  ENV_KEY_ACRONYMS,
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "./components";
export * from "./components/apps/overlay-app-api";
export * from "./components/apps/overlay-app-registry";
export * from "./components/apps/AppWindowRenderer";
export * from "./components/composites/index";
export * from "./components/composites/page-panel/index";
export * from "./components/index";
export * from "./components/onboarding/states/index";
export * from "./components/pages/vector-browser-utils";
export type {
  MemoryRecord,
  VectorGraph2DBounds,
  VectorGraph2DLayout,
  ViewMode,
} from "./components/pages/vector-browser-utils";
export {
  buildVectorGraph2DLayout,
  DIM_COLUMNS,
  hasEmbedding,
  MAX_THREE_PIXEL_RATIO,
  PAGE_SIZE,
  parseContent,
  parseEmbedding,
  projectTo2D,
  rowToMemory,
  toVectorGraph2DScreenX,
  toVectorGraph2DScreenY,
  VECTOR_GRAPH_2D_PALETTE,
} from "./components/pages/vector-browser-utils";
export * from "./components/primitives/index";
export { Switch } from "./components/ui/switch";
export { Textarea } from "./components/ui/textarea";
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs";
export type {
  ActionConfirm,
  ActionDefinition,
  ActionHandler,
  ActionOnError,
  ActionOnSuccess,
  AllowedHostPattern,
  AndroidUserAgentMarker,
  AndVisibility,
  AospVariantConfig,
  AppAndroidConfig,
  AppBootConfig,
  AppConfig,
  AppDesktopConfig,
  AppPackagingConfig,
  AppWebConfig,
  AuthState,
  AuthVisibility,
  BrandingConfig,
  BuiltinValidator,
  BundledVrmAsset,
  CatalogConfig,
  CharacterAssetEntry,
  CharacterCatalogData,
  ClientMiddleware,
  CondExpr,
  CodingAgentTasksPanelProps,
  CompanionInferenceNotice,
  CompanionSceneStatus,
  CompanionShellComponentProps,
  CustomProviderOption,
  DynamicProp,
  FieldCatalog,
  FieldDefinition,
  FieldRegistry,
  FieldRenderer,
  FieldRenderProps,
  InjectedCharacterEntry,
  JsonSchemaObject,
  JsonSchemaProperty,
  NotVisibility,
  OrVisibility,
  PatchOp,
  PathVisibility,
  RepeatConfig,
  ResolvedCharacterAsset,
  ResolvedField,
  ResolvedInjectedCharacter,
  ResolveCompanionInferenceNoticeArgs,
  StewardApprovalQueueProps,
  StewardLogoProps,
  StewardTransactionHistoryProps,
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
  ValidationFunction,
  VincentStateHookArgs,
  VincentStateHookResult,
  VisibilityOperator,
} from "./config";
export * from "./config/index";
export {
  appNameInterpolationVars,
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
  builtInValidators,
  check,
  DEFAULT_APP_DISPLAY_NAME,
  DEFAULT_BOOT_CONFIG,
  DEFAULT_BRANDING,
  defaultCatalog,
  defineCatalog,
  defineRegistry,
  evaluateLogicExpression,
  evaluateVisibility,
  findFormValue,
  getBootConfig,
  getByPath,
  interpolateString,
  parseAllowedHostEnv,
  resolveAppBranding,
  resolveCharacterCatalog,
  resolveDynamic,
  resolveFields,
  runValidation,
  setBootConfig,
  setByPath,
  shouldUseCloudOnlyBranding,
  syncBrandEnvToEliza,
  syncElizaEnvToBrand,
  toCapacitorAllowNavigation,
  toViteAllowedHosts,
  visibility,
} from "./config/index";
export * from "./content-packs/index";
// === Phase 5C: ./desktop-runtime moved to @elizaos/app-core/runtime/desktop ===
export * from "./desktop-shell-compat";
export type {
  AppDocumentEventName,
  AppEmoteEventDetail,
  AppEventName,
  AppWindowEventName,
  ChatAvatarVoiceEventDetail,
  ElizaCloudStatusUpdatedDetail,
  ElizaDocumentEventName,
  ElizaEventName,
  ElizaWindowEventName,
  NetworkStatusChangeDetail,
} from "./events";
export * from "./events/index";
export {
  AGENT_READY_EVENT,
  APP_EMOTE_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  BRIDGE_READY_EVENT,
  CHAT_AVATAR_VOICE_EVENT,
  COMMAND_PALETTE_EVENT,
  CONNECT_EVENT,
  dispatchAppEmoteEvent,
  dispatchAppEvent,
  dispatchElizaCloudStatusUpdated,
  dispatchWindowEvent,
  ELIZA_CLOUD_STATUS_UPDATED_EVENT,
  EMOTE_PICKER_EVENT,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  NETWORK_STATUS_CHANGE_EVENT,
  ONBOARDING_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT,
  SELF_STATUS_SYNC_EVENT,
  SHARE_TARGET_EVENT,
  STOP_EMOTE_EVENT,
  TRAY_ACTION_EVENT,
  VOICE_CONFIG_UPDATED_EVENT,
  VRM_TELEPORT_COMPLETE_EVENT,
} from "./events/index";
export * from "./hooks/index";
export type { ActivityEvent } from "./hooks/useActivityEvents";
export { useActivityEvents } from "./hooks/useActivityEvents";
export { useMediaQuery } from "./hooks/useMediaQuery";
export { useRenderGuard } from "./hooks/useRenderGuard";
export { useTimeout } from "./hooks/useTimeout";
export * from "./i18n/index";
export * from "./i18n/messages";
export * from "./layouts/index";
export { PageLayout } from "./layouts/page-layout/page-layout";
export * from "./lib/floating-layers";
export { Z_GLOBAL_EMOTE, Z_SYSTEM_CRITICAL } from "./lib/floating-layers";
export * from "./lib/utils";
export { cn } from "./lib/utils";
export * from "./navigation/index";
export type { Tab } from "./navigation/index";
export {
  installOnboardingDeepLinkListener,
  routeOnboardingDeepLink,
} from "./onboarding/deep-link-handler";
export * from "./onboarding/mobile-runtime-mode";
export * from "./onboarding/pre-seed-local-runtime";
// === Phase 5C: ./onboarding-config moved to @elizaos/app-core/onboarding/onboarding-config ===
export * from "./platform/index";
export * from "./providers/index";
export * from "./shell-params";
export * from "./slots/task-coordinator-slots";
export * from "./state/index";
export type {
  ActionNotice,
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
  InventoryChainFilters,
} from "./state/index";
export {
  AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
  computeStreamingDelta,
  getVrmPreviewUrl,
  getVrmUrl,
  mergeStreamingText,
  useCompanionSceneConfig,
  usePtySessions,
  useTranslation,
  useWalletState,
  VRM_COUNT,
} from "./state/index";
export type { UiTheme } from "./state/ui-preferences";
export * from "./themes/index.js";
export * from "./types/index";
export type {
  ElizaPluginViews,
  PluginViewProps,
  PluginViewRegistration,
} from "./types/plugin-views";
export type {
  BrowserTabKit,
  BrowserTabKitCursorPoint,
  BrowserTabKitDispatchOptions,
  BrowserTabKitMoveOptions,
  BrowserTabKitTypeOptions,
  BrowserTabsRendererImpl,
  ElizaWindow,
  ParseClampedIntegerOptions,
  ParseClampedNumberOptions,
  ParsePositiveNumberOptions,
  RateLimitCheck,
  RateLimiter,
  RateLimiterOptions,
  StreamingUpdateResult,
} from "./utils";
export * from "./utils";
export {
  BROWSER_TAB_PRELOAD_SCRIPT,
  clearElizaApiBase,
  clearElizaApiToken,
  createRateLimiter,
  createSerialise,
  ensureNamespaceDefaults,
  ensureRuntimeSqlCompatibility,
  errorMessage,
  executeRawSql,
  formatByteSize,
  formatDateTime,
  formatDurationMs,
  formatShortDate,
  formatSubscriptionRequestError,
  formatTime,
  formatUptime,
  getElizaApiBase,
  getElizaApiToken,
  getLogPrefix,
  isCloudStatusAuthenticated,
  isCloudStatusReasonApiKeyOnly,
  isEnvDisabled,
  isRedirectResponse,
  isSafeExecutableValue,
  isTimeoutError,
  isTtsDebugEnabled,
  modelLooksLikeElizaCloudHosted,
  normalizeCharacterMessageExamples,
  normalizeEnvValue,
  normalizeEnvValueOrNull,
  normalizeOpenAICallbackInput,
  normalizeOwnerName,
  OWNER_NAME_MAX_LENGTH,
  parseClampedFloat,
  parseClampedInteger,
  parsePositiveFloat,
  parsePositiveInteger,
  quoteIdent,
  replaceNameTokens,
  resolveApiUrl,
  resolveAppAssetUrl,
  resolveElizaPackageRoot,
  resolveElizaPackageRootSync,
  resolveStreamingUpdate,
  sanitizeIdentifier,
  setBrowserTabsRendererImpl,
  setElizaApiBase,
  setElizaApiToken,
  sqlLiteral,
  stripAssistantStageDirections,
  syncAppEnvToEliza,
  syncElizaEnvAliases,
  tokenizeNameOccurrences,
  ttsDebug,
  ttsDebugTextPreview,
} from "./utils";
export type { DesktopPowerState } from "./utils/desktop-workspace";
export {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
} from "./bridge/index";
export type { UiLanguage } from "./i18n/index";
export type { TranslateFn } from "./components/pages/config-page-sections";
export { resolveCharacterGreetingAnimation } from "./components/character/character-greeting";
export {
  AppPageSidebar,
} from "./components/shared/AppPageSidebar";
export { SidebarContent } from "./components/composites/sidebar/sidebar-content";
export { SidebarPanel } from "./components/composites/sidebar/sidebar-panel";
export { SidebarScrollRegion } from "./components/composites/sidebar/sidebar-scroll-region";
export {
  LanguageDropdown,
  ThemeToggle,
} from "./components/index";
export {
  EmptyWidgetState,
  WidgetSection,
} from "./components/chat/widgets/shared";
export type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./components/chat/widgets/types";
export { IconTooltip } from "./components/ui/tooltip-extended";
export * from "./views/view-event-bus";
export * from "./views/view-event-types";
export * from "./voice";
export * from "./widgets";
export * from "./widgets/registry-store";
