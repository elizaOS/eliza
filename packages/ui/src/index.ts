/**
 * Main barrel for @elizaos/ui: the package's public export surface. Stylesheets
 * live in `./styles.ts` (`@elizaos/ui/styles`) so this barrel can be imported by
 * Node-side plugin loaders without forcing a CSS evaluation (Node refuses ".css"
 * extensions); renderers must opt into styles explicitly.
 */

export { resolveAppBranding } from "@elizaos/shared";
export * from "./App";
export * from "./agent-surface";
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
export * from "./api/ios-local-agent-transport";
export * from "./app-navigate-view";
export * from "./app-shell-components";
export * from "./app-shell-registry";
export { registerAppShellPage } from "./app-shell-registry";
export * from "./backgrounds/index";
export * from "./bridge/index";
export {
  invokeDesktopBridgeRequest,
  isElectrobunRuntime,
} from "./bridge/index";
export * from "./cache-telemetry";
export * from "./character-catalog";
export {
  DEFAULT_ELIZA_CHARACTER_ASSET,
  getCharacterAsset,
  getCharacterAssets,
  getInjectedCharacter,
  getInjectedCharacters,
} from "./character-catalog";
export * from "./chat/index";
// App-hosted Eliza Cloud surfaces (API client, query client, steward-session
// glue, cloud-route registry). Namespaced to avoid colliding with the many
// generic names (`api`, `ApiError`, `queryClient`, …) in the root barrel.
export { AuthorizeContent } from "./cloud-ui/components/auth/authorize-content";
export * from "./cloud-ui/components/auth/authorize-return";
export type { ConnectionCardProps } from "./cloud-ui/components/connection-card";
export {
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionCopyRow,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
  ConnectionInstructions,
  ConnectionLoadingCard,
} from "./cloud-ui/components/connection-card";
// ConnectionStatus is intentionally not re-exported here to avoid collision
// with ConnectionStatus from ./components/composites/index (the UI component).
// The cloud-ui ConnectionStatus type is a string union used internally.
export {
  AppleMessagesIcon,
  DiscordIcon,
  IMessageIcon,
  TelegramIcon,
  WhatsAppIcon,
} from "./cloud-ui/components/icons";
export {
  AnimatedCounter,
  AnimatedCounterWithLabel,
  EarningsSimulator,
  MilestoneCard,
  MilestoneProgress,
  RevenueFlowDiagram,
} from "./cloud-ui/components/monetization";
export { NavigationProgress } from "./cloud-ui/components/navigation-progress";
export {
  ProductSwitcher,
  type ProductSwitcherItem,
  type ProductSwitcherProps,
} from "./cloud-ui/components/product-switcher";
export { PromoteAppDialog } from "./cloud-ui/components/promotion/promote-app-dialog";
export { SocialConnectionHint } from "./cloud-ui/components/promotion/social-connection-hint";
export {
  ThemeProvider,
  ThemeToggle as CloudThemeToggle,
  useTheme,
} from "./cloud-ui/components/theme";
export {
  getEstimatedReadyMessage,
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
  type UseAudioPlayerReturn,
  type UseAudioRecorderReturn,
  useAudioPlayer,
  useAudioRecorder,
  type Voice,
  VoiceAudioPlayer,
  type VoiceCloneJob,
  VoiceEmptyState,
  type VoiceSettings,
  VoiceStatusBadge,
} from "./cloud-ui/components/voice";
export { default as dynamic } from "./cloud-ui/runtime/dynamic";
export { default as Image } from "./cloud-ui/runtime/image";
export * from "./cloud-ui/runtime/navigation";
export { RenderTelemetryProfiler } from "./cloud-ui/runtime/render-telemetry";
export {
  type ChatMediaAttachment,
  ContentType,
} from "./cloud-ui/types/chat-media";
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
export * from "./components/apps/AppWindowRenderer";
export * from "./components/apps/AppWindowRenderer.helpers";
export * from "./components/apps/EmbeddedAppViewer";
export * from "./components/apps/extensions/registry";
export * from "./components/apps/extensions/surface";
export * from "./components/apps/extensions/surface.helpers";
export * from "./components/apps/extensions/types";
export * from "./components/apps/overlay-app-api";
export * from "./components/apps/overlay-app-registry";
export { resolveCharacterGreetingAnimation } from "./components/character/character-greeting";
// Vision-critical chat widgets (#8933) — presentational only, exported with
// their public prop/value types for stories + host wiring.
export {
  type BrowserLaunchStatus,
  BrowserLaunchWidget,
  type BrowserLaunchWidgetProps,
} from "./components/chat/widgets/browser-launch-widget";
export {
  getInlineWidget,
  getInlineWidgets,
  type InlineWidgetContext,
  type InlineWidgetDefinition,
  type InlineWidgetMatch,
  registerInlineWidget,
} from "./components/chat/widgets/inline-registry";
export {
  type GrillingCriterion,
  type GrillingCriterionState,
  type GrillingStatus,
  OrchestratorGrillingCard,
  type OrchestratorGrillingCardProps,
} from "./components/chat/widgets/orchestrator-grilling-card";
export {
  EmptyWidgetState,
  WidgetSection,
} from "./components/chat/widgets/shared";
export { registerTaskWidget } from "./components/chat/widgets/task-widget";
export {
  type TopicChip,
  TopicChipsBar,
  type TopicChipsBarProps,
} from "./components/chat/widgets/topic-chips-bar";
export {
  type TopicGroup,
  TopicGroupedTranscript,
  type TopicGroupedTranscriptProps,
} from "./components/chat/widgets/topic-grouped-transcript";
export type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./components/chat/widgets/types";
export {
  buildCockpitCreateTaskInput,
  type CockpitModeConfig,
  CockpitModePicker,
  CockpitNewSessionForm,
  CockpitTierToggle,
  type CockpitTierToggleProps,
  CockpitView,
  type CockpitViewProps,
  cockpitModeToProviderPolicy,
  ELIZA_CLOUD_TIER_MODEL,
  type ElizaCloudTier,
} from "./components/cockpit/index";
// Surfaced directly on the root barrel (also reachable via the composites/hooks
// chains) so dist-mapped consumers resolve them by name.
export {
  ChatEmptyStateWithRecommendations,
  type ChatEmptyStateWithRecommendationsProps,
  type ChatRecommendation,
} from "./components/composites/chat/ChatEmptyStateWithRecommendations";
export { ChatSearchHint } from "./components/composites/chat-search-hint";
export * from "./components/composites/index";
export * from "./components/composites/page-panel/index";
export { SidebarContent } from "./components/composites/sidebar/sidebar-content";
export { SidebarPanel } from "./components/composites/sidebar/sidebar-panel";
export { SidebarScrollRegion } from "./components/composites/sidebar/sidebar-scroll-region";
export * from "./components/index";
export {
  FormField,
  LanguageDropdown,
  ThemeToggle,
} from "./components/index";
export type { TranslateFn } from "./components/pages/config-page-sections";
export type {
  MemoryRecord,
  VectorGraph2DBounds,
  VectorGraph2DLayout,
  ViewMode,
} from "./components/pages/vector-browser-utils";
export * from "./components/pages/vector-browser-utils";
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
export {
  SettingsActionButton,
  SettingsInputRow,
  SettingsSegmentedRow,
  SettingsSelectRow,
  SettingsSwitchRow,
  SettingsTextareaRow,
} from "./components/settings/settings-agent-rows";
export {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "./components/settings/settings-layout";
export {
  getAllSettingsSections,
  getSettingsSection,
  listSettingsSections,
  registerSettingsSection,
  type SettingsSectionDef,
} from "./components/settings/settings-section-registry";
export { AppPageSidebar } from "./components/shared/AppPageSidebar";
export {
  isSectionPath,
  SectionNav,
  SectionNavTab,
  type SectionPathRewrite,
  type SectionTab,
  SectionTabStrip,
  sectionTabs,
} from "./components/shared/SectionNav";
export {
  navigateBackToLauncher,
  ViewBackButton,
  ViewHeader,
} from "./components/shared/ViewHeader";
export {
  assertSharedViewHeader,
  DEFAULT_VIEW_HEADER_POLICY,
  hasSharedViewHeader,
  VIEW_HEADER_TESTID,
  viewRequiresSharedHeader,
} from "./components/shared/view-header-audit";
export {
  AssistantOverlay,
  type AssistantOverlayProps,
} from "./components/shell/AssistantOverlay";
export {
  ChatSurface,
  type ChatSurfaceProps,
} from "./components/shell/ChatSurface";
export { HomePill, type HomePillProps } from "./components/shell/HomePill";
export {
  HomeScreen,
  type HomeScreenProps,
  type HomeTileTarget,
} from "./components/shell/HomeScreen";
export type {
  ShellMessage,
  ShellPhase,
} from "./components/shell/shell-state";
export {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
} from "./components/ui/select";
export { SettingsControls } from "./components/ui/settings-controls";
export { Switch } from "./components/ui/switch";
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./components/ui/tabs";
export { Textarea } from "./components/ui/textarea";
export { IconTooltip } from "./components/ui/tooltip-extended";
export { KeepAliveViewHost } from "./components/views/KeepAliveViewHost";
export { TerminalPluginView } from "./components/views/TerminalPluginView";
export { ViewErrorBoundary } from "./components/views/ViewErrorBoundary";
export { ViewTelemetryProfiler } from "./components/views/ViewTelemetryProfiler";
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
  CodingAgentTasksPanelProps,
  CondExpr,
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
  FIRST_RUN_VOICE_PREVIEW_AWAIT_TELEPORT_EVENT,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  NETWORK_STATUS_CHANGE_EVENT,
  SELF_STATUS_SYNC_EVENT,
  SHARE_TARGET_EVENT,
  STOP_EMOTE_EVENT,
  TRAY_ACTION_EVENT,
  VOICE_CONFIG_UPDATED_EVENT,
  VRM_TELEPORT_COMPLETE_EVENT,
} from "./events/index";
export {
  installFirstRunDeepLinkListener,
  routeFirstRunDeepLink,
} from "./first-run/deep-link-handler";
export * from "./first-run/first-run-config";
export * from "./first-run/mobile-runtime-mode";
export * from "./first-run/pre-seed-local-runtime";
export * from "./genui/index";
export * from "./gestures";
export {
  DEFAULT_FRAME_BUDGET,
  FRAME_SAMPLER_INIT,
  type FrameBudget,
  type FrameBudgetSummary,
  type FrameBudgetTelemetryEvent,
  frameBudgetMs,
  shouldReportFrameBudget,
  summarizeFrameSamples,
} from "./hooks/frame-budget";
export * from "./hooks/index";
export type { ActivityEvent } from "./hooks/useActivityEvents";
export { useActivityEvents } from "./hooks/useActivityEvents";
export { useChatPrefill } from "./hooks/useChatPrefill";
export { useIntervalWhenDocumentVisible } from "./hooks/useDocumentVisibility";
export {
  type FrameBudgetMonitorOptions,
  isPerfHudEnabled,
  startFrameBudgetMonitor,
  useFrameBudgetMonitor,
} from "./hooks/useFrameBudgetMonitor";
export {
  DEFAULT_CLS_BUDGET,
  type LayoutShiftMonitorOptions,
  type LayoutShiftTelemetryEvent,
  startLayoutShiftMonitor,
  useLayoutShiftMonitor,
} from "./hooks/useLayoutShiftMonitor";
export { useMediaQuery } from "./hooks/useMediaQuery";
export {
  type AnyRenderTelemetryEvent,
  type ProfilerRenderTelemetryEvent,
  RENDER_TELEMETRY_EVENT,
  type RenderTelemetryEvent,
  type RenderTelemetrySeverity,
  setRenderTelemetrySink,
  useRenderGuard,
} from "./hooks/useRenderGuard";
export { useTimeout } from "./hooks/useTimeout";
export type { UiLanguage } from "./i18n/index";
// `./i18n/index` already re-exports the full `./i18n/messages` surface
// (language codes, MESSAGES, ensureLanguageLoaded); re-exporting messages again
// here would double-surface those names and make the barrel ambiguous.
export * from "./i18n/index";
export { ContentLayout } from "./layouts/content-layout/content-layout";
export * from "./layouts/index";
export { PageLayout } from "./layouts/page-layout/page-layout";
export * from "./lib/floating-layers";
export { Z_GLOBAL_EMOTE, Z_SYSTEM_CRITICAL } from "./lib/floating-layers";
export * from "./lib/utils";
export { cn } from "./lib/utils";
export type { Tab } from "./navigation/index";
export * from "./navigation/index";
export {
  type ResourceCountersSnapshot,
  snapshotResourceCounters,
  totalLiveResources,
  trackMedia,
  trackSubscription,
  trackTimer,
} from "./perf/resource-counters";
export {
  type MemoryBudgetReport,
  type MemorySampleSummary,
  shouldReportMemoryGrowth,
  summarizeMemorySamples,
} from "./perf/view-memory-budget";
export * from "./platform/index";
export * from "./providers/index";
export * from "./shell-params";
export * from "./slots/task-coordinator-slots";
export * from "./slots/task-coordinator-slots.helpers";
export {
  getKeepAliveMaxViews,
  getKeepAliveTtlMs,
  isLowMemoryDevice,
} from "./state/bounded-view-lru";
export type {
  ActionNotice,
  InventoryChainFilters,
} from "./state/index";
export * from "./state/index";
export {
  AGENT_TRANSFER_MIN_PASSWORD_LENGTH,
  computeStreamingDelta,
  getVrmPreviewUrl,
  getVrmUrl,
  mergeStreamingText,
  useAppSelector,
  useAppSelectorShallow,
  usePtySessions,
  useTranslation,
  useWalletState,
  VRM_COUNT,
} from "./state/index";
export type { UiTheme } from "./state/ui-preferences";
export {
  usePausableInterval,
  usePauseAware,
  useViewLifecycle,
  type ViewLifecycleHandlers,
  type ViewLifecycleState,
} from "./state/useViewLifecycle";
export {
  useRegisterViewChatBinding,
  type ViewChatBinding,
} from "./state/view-chat-binding";
// View lifecycle / memory / crash-containment primitives (#10202).
export {
  PINNED_VIEW_IDS,
  registerViewPolicy,
  resolveViewLifecyclePolicy,
  type ViewLifecycleController,
  type ViewRenderSet,
  viewLifecycleController,
} from "./state/view-lifecycle";
export {
  useViewLifecycleSlot,
  ViewLifecycleSlot,
} from "./state/view-lifecycle-context";
export type {
  ViewLifecyclePhase,
  ViewLifecyclePolicy,
  ViewLifecycleTransition,
} from "./state/view-lifecycle-types";
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
export { confirmDesktopAction } from "./utils/desktop-dialogs";
export type { DesktopPowerState } from "./utils/desktop-workspace";
export { openExternalUrl } from "./utils/openExternalUrl";
export {
  emitViewRuntimeTelemetry,
  installViewRuntimeTelemetryRing,
  readViewRuntimeTelemetry,
  VIEW_RUNTIME_TELEMETRY_EVENT,
  type ViewRuntimeTelemetryEvent,
} from "./view-runtime-telemetry";
export * from "./views/view-event-bus";
export * from "./views/view-event-types";
export * from "./voice";
export * from "./widgets";
export * from "./widgets/registry-store";
