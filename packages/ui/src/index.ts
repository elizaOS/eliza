/** Public UI APIs. Internal modules import their owning files directly. */

export { AgentSurfaceProvider } from "./agent-surface/AgentSurfaceContext.js";
export { AgentButton } from "./agent-surface/components.js";
export { getViewRegistry } from "./agent-surface/registry.js";
export { useAgentElement } from "./agent-surface/useAgentElement.js";
export { completeAndroidCloudSignIn } from "./android-cloud/android-cloud-auth.js";
export { shouldAcknowledgeAndroidCloudCallback } from "./android-cloud/android-cloud-client.js";
export {
  abortableResponse,
  runAbortableRequest,
} from "./api/abortable-request.js";
export { supportsFullAppShellRoutes } from "./api/app-shell-capabilities.js";
export { client, ElizaClient } from "./api/client.js";
export {
  cloudTokenSecsRemaining,
  type DedicatedAdoptionConfirmationQuote,
  type DedicatedAdoptionConfirmationRequester,
  getCloudAuthToken,
  isDirectCloudSharedAgentBase,
  refreshCloudStewardSession,
} from "./api/client-cloud.js";
export type {
  Conversation,
  ConversationMessage,
  ConversationSecretRequest,
  DocumentDetail,
  DocumentFragmentRecord,
  DocumentRecord,
  DocumentScope,
  DocumentSearchResult,
} from "./api/client-types-chat.js";
export type {
  AgentPreflightResult,
  ChangeSetData,
  CloudApiKeys,
  CloudBillingCheckoutResponse,
  CloudBillingSettings,
  CloudBillingSummary,
  CloudCompatAgent,
  CloudCredits,
  CloudStatus,
  CodingAgentAddAgentInput,
  CodingAgentCreateTaskInput,
  CodingAgentOrchestratorStatus,
  CodingAgentRerunFromEventInput,
  CodingAgentRestartWithEditedPlanInput,
  CodingAgentRetryTurnInput,
  CodingAgentSession,
  CodingAgentTaskArtifactRecord,
  CodingAgentTaskDecisionRecord,
  CodingAgentTaskEventRecord,
  CodingAgentTaskMessageRecord,
  CodingAgentTaskSessionRecord,
  CodingAgentTaskThread,
  CodingAgentTaskThreadDetail,
  CodingAgentTaskTimelineItem,
  CodingAgentTaskUsageSummary,
  LocalAgentBackupMetadata,
  OrchestratorRoomRosterOverview,
  ProjectSummary,
} from "./api/client-types-cloud.js";
export type { PluginInfo } from "./api/client-types-config.js";
export type {
  AgentBootProgress,
  AgentStartupDiagnostics,
  AgentStatus,
  LaunchSnapshot,
  ScheduledTaskView,
  StreamEventEnvelope,
} from "./api/client-types-core.js";
export {
  ApiError,
  isApiError,
  isCloudAgentGoneError,
  isRateLimitedError,
} from "./api/client-types-core.js";
export {
  type ConversationRoom,
  type ConversationStopResult,
  ConversationTurnController,
  type ConversationTurnObserver,
  type ConversationTurnTransport,
} from "./api/conversation-turn-controller.js";
export { fetchWithCsrf } from "./api/csrf-client.js";
export type {
  DedicatedActivationConfirmationQuote,
  DedicatedActivationConfirmationRequester,
} from "./api/dedicated-activation-confirmation.js";
export { isDesktopExternalHttpApiBaseUrl } from "./api/desktop-external-api-base.js";
export {
  configureHostAgentCapabilities,
  configureHostTransport,
  type HostAgentCapabilities,
  type NativeAgentHttpRequest,
  type NativeAgentHttpResponse,
  type NativeAgentLifecycle,
} from "./api/host-transport.js";
export {
  type NativeHttpResult,
  nativeHttpResultToResponse,
} from "./api/native-http-codec.js";
export { isPasswordAuthTransportConfidential } from "./api/password-auth-transport-policy.js";
export { RemoteControlCloudClient } from "./api/remote-control-cloud-client.js";
export {
  createDefaultRemoteControlCloudClient,
  getDefaultRemoteControlCloudConnection,
} from "./api/remote-control-cloud-default.js";
export {
  createRuntimeJsonClient,
  type RuntimeJsonBridge,
  type RuntimeJsonResponse,
  RuntimeRequestError,
  type RuntimeStatus,
} from "./api/runtime-json-client.js";
export {
  TaskLifecycle,
  type TaskLifecycleMessages,
  type TaskLifecycleRequest,
  type TaskLifecycleState,
  type TaskView,
} from "./api/task-lifecycle.js";
export {
  type AgentRequestTransport,
  awaitBridgeRequest,
  bodyToString,
  fetchAgentTransport,
  headersToRecord,
  isStreamingRequest,
  methodAllowsBody,
  requireTextRequestBody,
} from "./api/transport.js";
export {
  type ActiveViewLayout,
  consumeNavigateViewPayload,
  createNavigateViewHandler,
  navigateBrowserPath,
} from "./app-navigate-view.js";
export {
  type AppShellPageRegistration,
  appShellAgentSurfaceDescriptor,
  appShellPageIsAvailable,
  appShellPageMatchesPath,
  getAppShellPageRegistrySnapshot,
  listAppShellPages,
  registerAppShellPage,
  registerHostExternalImporter,
  requireRegisteredAgentSurface,
  subscribeAppShellPages,
} from "./app-shell-registry.js";
export { registerDetailExtension } from "./apps/detail-extension-registry.js";
export type { AppDetailExtensionProps } from "./apps/detail-extension-types.js";
export type { OverlayApp, OverlayAppContext } from "./apps/overlay-app-api.js";
export {
  getOverlayApp,
  registerOverlayApp,
} from "./apps/overlay-app-registry.js";
export { AppBackground } from "./backgrounds/AppBackground.js";
export { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "./brand/index.js";
export { initializeCapacitorBridge } from "./bridge/capacitor-bridge.js";
export {
  type DesktopBottomBarSurfaceState,
  getDesktopRuntimeMode,
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
  invokeDesktopBridgeRequestWithTimeout,
  openDesktopAppWindow,
  setDesktopBottomBarSurfaceState,
  subscribeDesktopBridgeEvent,
} from "./bridge/electrobun-rpc.js";
export {
  getBackendStartupTimeoutMs,
  isElectrobunRuntime,
} from "./bridge/electrobun-runtime.js";
export type { ElizaWindowBridge } from "./bridge/eliza-window-bridge.js";
export {
  installElizaBridge,
  registerElizaBridgeCapability,
} from "./bridge/eliza-window-bridge.js";
export {
  getAppBlockerPlugin,
  getLiveActivityPlugin,
  type LiveActivityPluginLike,
} from "./bridge/native-plugins.js";
export {
  getStorageValue,
  initializeStorageBridge,
  removeStorageValue,
  setStorageValue,
} from "./bridge/storage-bridge.js";
export { isStoreBuild } from "./build-variant.js";
export {
  isImmersiveWallpaperRoute,
  resolveBuiltinBackgroundPolicy,
  resolveBuiltinRoutedViewManifest,
} from "./builtin-tab-registry.js";
export type { ServerTask } from "./chat/coding-agent-session-state.js";
export {
  mapServerTasksToSessions,
  PULSE_STATUSES,
  STATUS_DOT,
  TERMINAL_STATUSES,
} from "./chat/index.js";
export {
  NAVIGATE_SETTINGS_EVENT,
  type NavigateSettingsDetail,
} from "./chat/shortcut-report.js";
export {
  reportUserViewClosed,
  reportUserViewSwitch,
  shouldClearReportedView,
} from "./chat/view-navigation-report.js";
export { resumePendingCloudHandoff } from "./cloud/handoff/resume-pending-handoff.js";
export { registerJoinFlow } from "./cloud/join/register.js";
export { normalizeCloudApiKeyToken } from "./cloud/lib/cloud-api-key-token.js";
export { useSessionAuth } from "./cloud/lib/use-session-auth.js";
export { isManagedCloudRuntime } from "./cloud/managed-cloud-runtime.js";
export { registerPublicPages } from "./cloud/public-pages/register.js";
export { CloudRouterShell } from "./cloud/shell/CloudRouterShell.js";
export { RenderTelemetryProfiler } from "./cloud-ui/runtime/render-telemetry.js";
export {
  dispatchCompletedActionNavigation,
  markCompletedActionNavigationHandled,
} from "./completed-action-navigation.js";
export { AccountList } from "./components/accounts/AccountList.js";
export {
  AppWindowRenderer,
  OverlayAppSurface,
} from "./components/apps/AppWindowRenderer.js";
export {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "./components/apps/extensions/surface.helpers.js";
export {
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  type SurfaceTone,
} from "./components/apps/extensions/surface.js";
export { GameViewOverlay } from "./components/apps/GameViewOverlay.js";
export { prefetchAppsCatalog } from "./components/apps/load-apps-catalog.js";
export { AgentAuthGateSurface } from "./components/auth/AgentAuthGateSurface.js";
export {
  CloudPairRelay,
  getCloudPairTokenFromLocation,
  isElizaCloudHostedLocation,
  resolveCloudHostedAgentUrl,
} from "./components/auth/CloudPairRelay.js";
export {
  CharacterSectionNav,
  isCharacterSectionPath,
} from "./components/character/CharacterSectionNav.js";
export { OrchestratorAccountsView } from "./components/chat/widgets/agent-orchestrator-accounts-view.js";
export { OrchestratorTaskWidget } from "./components/chat/widgets/orchestrator-task-widget.js";
export {
  EmptyWidgetState,
  WidgetSection,
} from "./components/chat/widgets/shared.js";
export { registerTaskWidget } from "./components/chat/widgets/task-widget.js";
export type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./components/chat/widgets/types.js";
export { CockpitTierToggle } from "./components/cockpit/CockpitTierToggle.js";
export { CockpitView } from "./components/cockpit/CockpitView.js";
export {
  type CockpitSpawnTarget,
  ELIZA_CLOUD_TIER_MODEL,
  type ElizaCloudTier,
} from "./components/cockpit/cockpit-modes.js";
export { DiffReviewPanel } from "./components/composites/DiffReviewPanel.js";
export {
  PageLoadingState,
  PagePanel,
} from "./components/composites/page-panel/index.js";
export { CustomActionEditor } from "./components/custom-actions/CustomActionEditor.js";
export { CustomActionsPanel } from "./components/custom-actions/CustomActionsPanel.js";
export { DesktopTabBar } from "./components/DesktopTabBar.js";
export {
  TaskChoice,
  type TaskChoiceMessages,
} from "./components/interactive-task/TaskChoice.js";
export { AppsPageView } from "./components/pages/AppsPageView.js";
export { LauncherSurface } from "./components/pages/LauncherSurface.js";
export { PluginPageFrame } from "./components/pages/PluginPageFrame.js";
export { PluginsPageView } from "./components/pages/PluginsPageView.js";
export {
  isWalletSectionPath,
  WalletSectionNav,
} from "./components/pages/WalletSectionNav.js";
export { PermissionPrimingOverlay } from "./components/permissions/PermissionPrimingOverlay.js";
export { PermissionRecoveryCallout } from "./components/permissions/PermissionRecoveryCallout.js";
export { ShellModalityProvider } from "./components/ShellModalityProvider.js";
export { ShellRoleProvider } from "./components/ShellRoleProvider.js";
export {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "./components/settings/settings-layout.js";
export { ActionListRow } from "./components/shared/ActionListRow.js";
export { AppPageSidebar } from "./components/shared/AppPageSidebar.js";
export { ConfirmDeleteControl } from "./components/shared/confirm-delete-control.js";
export { SectionNav, SectionTabStrip } from "./components/shared/SectionNav.js";
export { ViewBackButton, ViewHeader } from "./components/shared/ViewHeader.js";
export { ActionNoticeToast } from "./components/shell/ActionNoticeToast.js";
export { AssistantOverlay } from "./components/shell/AssistantOverlay.js";
export { BugReportModal } from "./components/shell/BugReportModal.js";
export { BuildBadge } from "./components/shell/BuildBadge.js";
export { ChatOverlay } from "./components/shell/ChatOverlay.js";
export { ChatSurface } from "./components/shell/ChatSurface.js";
export { CloudSignInRecoveryView } from "./components/shell/CloudSignInRecoveryView.js";
export { ConnectionLostOverlay } from "./components/shell/ConnectionLostOverlay.js";
export { DynamicPluginFallback } from "./components/shell/DynamicPluginFallback.js";
export { HomeLauncherSurface } from "./components/shell/HomeLauncherSurface.js";
export { HomePill } from "./components/shell/HomePill.js";
export {
  HomeScreen,
  type HomeTileTarget,
} from "./components/shell/HomeScreen.js";
export { initializeIosKeyboardAccessoryBar } from "./components/shell/ios-chat-accessory-bar.js";
export { KioskViewCanvas } from "./components/shell/KioskViewCanvas.js";
export {
  NotificationsDataBoot,
  NotificationsShellBoot,
} from "./components/shell/notifications-boot.js";
export { PairingView } from "./components/shell/PairingView.js";
export { useShellControllerContext } from "./components/shell/ShellControllerContext.hooks.js";
export { ShellControllerProvider } from "./components/shell/ShellControllerContext.js";
export { ShellOverlays } from "./components/shell/ShellOverlays.js";
export { StartupFailureView } from "./components/shell/StartupFailureView.js";
export { StartupScreen } from "./components/shell/StartupScreen.js";
export { StartupShell } from "./components/shell/StartupShell.js";
export { SystemWarningBanner } from "./components/shell/SystemWarningBanner.js";
export { TrayLauncher } from "./components/shell/TrayLauncher.js";
export { useBarSurfaceWindows } from "./components/shell/useBarSurfaceWindows.js";
export { useKioskViewSurfaces } from "./components/shell/useKioskViewSurfaces.js";
export { VoiceCaptureHud } from "./components/shell/VoiceCaptureHud.js";
export { TranscriptPlayer } from "./components/transcripts/TranscriptPlayer.js";
export { ArtifactPrivacyControls } from "./components/transcripts/TranscriptsView.js";
export { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.js";
export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./components/ui/alert-dialog.js";
export {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "./components/ui/attachment.js";
export {
  Avatar,
  AvatarFallback,
  type AvatarFallbackTone,
  AvatarImage,
} from "./components/ui/avatar.js";
export {
  Badge,
  type BadgeProps,
  badgeVariants,
} from "./components/ui/badge.js";
export {
  Button,
  type ButtonProps,
  buttonVariants,
} from "./components/ui/button.js";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  type CardProps,
  CardTitle,
  cardVariants,
} from "./components/ui/card.js";
export { Checkbox } from "./components/ui/checkbox.js";
export { CodeBlock, type CodeBlockProps } from "./components/ui/code-block.js";
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible.js";
export { useConfirm, usePrompt } from "./components/ui/confirm-dialog.hooks.js";
export { ConfirmDialog, PromptDialog } from "./components/ui/confirm-dialog.js";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
export {
  ErrorBoundary,
  ErrorBoundaryFallback,
  type ErrorBoundaryFallbackProps,
  type ErrorBoundaryProps,
} from "./components/ui/error-boundary.js";
export { FormSelect, FormSelectItem } from "./components/ui/form-select.js";
export { Grid, type GridProps } from "./components/ui/grid.js";
export {
  Input,
  type InputProps,
  inputVariants,
} from "./components/ui/input.js";
export {
  InputGroup,
  InputGroupAddon,
  type InputGroupAddonProps,
  InputGroupButton,
  type InputGroupButtonProps,
  InputGroupInput,
  type InputGroupProps,
  InputGroupText,
  InputGroupTextarea,
  inputGroupVariants,
} from "./components/ui/input-group.js";
export { Label } from "./components/ui/label.js";
export {
  Marker,
  MarkerContent,
  MarkerIcon,
  markerVariants,
} from "./components/ui/marker.js";
export {
  Message,
  MessageAvatar,
  MessageContent as MessageRowContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "./components/ui/message.js";
export {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "./components/ui/message-scroller.js";
export {
  NativeDialog,
  type NativeDialogProps,
} from "./components/ui/native-dialog.js";
export {
  NativeSelect,
  type NativeSelectProps,
  nativeSelectVariants,
} from "./components/ui/native-select.js";
export {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.js";
export { Progress } from "./components/ui/progress.js";
export { RadioGroup, RadioGroupItem } from "./components/ui/radio-group.js";
export {
  SegmentedControl,
  type SegmentedControlItem,
  type SegmentedControlProps,
} from "./components/ui/segmented-control.js";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  type SelectItemProps,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.js";
export { SemanticForm } from "./components/ui/semantic-form.js";
export { Separator } from "./components/ui/separator.js";
export {
  SettingsControls,
  SettingsField,
  SettingsFieldDescription,
  SettingsFieldLabel,
  SettingsInput,
  type SettingsInputProps,
  type SettingsInputVariant,
  SettingsMutedText,
  type SettingsMutedTextProps,
  SettingsSegmentedGroup,
  type SettingsSegmentedGroupProps,
  SettingsSelectTrigger,
  type SettingsSelectTriggerProps,
  type SettingsSelectTriggerVariant,
  SettingsTextarea,
  type SettingsTextareaProps,
} from "./components/ui/settings-controls.js";
export { Skeleton } from "./components/ui/skeleton.js";
export {
  CompactCardSkeleton,
  DetailSkeleton,
  ListSkeleton,
  TableSkeleton,
} from "./components/ui/skeleton-layouts.js";
export { Slider } from "./components/ui/slider.js";
export { Spinner, type SpinnerProps } from "./components/ui/spinner.js";
export { Stack, type StackProps } from "./components/ui/stack.js";
export {
  StatusBadge,
  type StatusBadgeProps,
  StatusDot,
  type StatusDotProps,
  StatusPulseDot,
  type StatusTone,
  type StatusVariant,
} from "./components/ui/status-badge.js";
export { Switch } from "./components/ui/switch.js";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  type TableCellProps,
  TableFooter,
  TableFrame,
  TableHead,
  TableHeader,
  type TableHeaderProps,
  type TableHeadProps,
  type TableProps,
  TableRow,
  type TableRowProps,
} from "./components/ui/table.js";
export {
  Tabs,
  TabsContent,
  TabsList,
  type TabsListProps,
  TabsTrigger,
  type TabsTriggerProps,
} from "./components/ui/tabs.js";
export { TagEditor, type TagEditorProps } from "./components/ui/tag-editor.js";
export {
  TextLink,
  type TextLinkProps,
  textLinkVariants,
} from "./components/ui/text-link.js";
export {
  Textarea,
  type TextareaProps,
  textareaVariants,
} from "./components/ui/textarea.js";
export {
  Tooltip,
  TooltipContent,
  TooltipHint,
  type TooltipHintProps,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip.js";
export {
  Heading,
  type HeadingProps,
  Text,
  type TextProps,
} from "./components/ui/typography.js";
export { DynamicViewLoader } from "./components/views/DynamicViewLoader.js";
export { registerDeviceControlInteractHandler } from "./components/views/device-control-interact.js";
export { KeepAliveViewHost } from "./components/views/KeepAliveViewHost.js";
export { ShellViewAgentSurface } from "./components/views/ShellViewAgentSurface.js";
export { registerSandboxProbeView } from "./components/views/sandbox-probe-view.js";
export { ViewErrorBoundary } from "./components/views/ViewErrorBoundary.js";
export { ViewUnavailableState } from "./components/views/ViewStatusStates.js";
export { AppWorkspaceChrome } from "./components/workspace/AppWorkspaceChrome.js";
export { AppWorkspaceContent } from "./components/workspace/AppWorkspaceContent.js";
export {
  AppBootContext,
  useBootConfig,
} from "./config/boot-config-react.hooks.js";
export {
  type AppBootConfig,
  type CharacterCatalogData,
  DEFAULT_BOOT_CONFIG,
  getBootConfig,
  setBootConfig,
} from "./config/boot-config-store.js";
export {
  appNameInterpolationVars,
  type BrandingConfig,
  DEFAULT_BRANDING,
} from "./config/branding-base.js";
export { BrandingContext, useBranding } from "./config/branding-react.hooks.js";
export {
  AGENT_READY_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  CHAT_OPEN_EVENT,
  COMMAND_PALETTE_EVENT,
  type ConnectRequestResult,
  dispatchAppEmoteEvent,
  dispatchAppEvent,
  dispatchBackIntent,
  dispatchChatOpen,
  dispatchChatPrefill,
  dispatchConnectRequest,
  dispatchFocusConnector,
  dispatchNavigateViewEvent,
  dispatchNavigateViewRequest,
  dispatchOpenNotificationCenter,
  dispatchVoiceControl,
  FOCUS_CONNECTOR_EVENT,
  type FocusConnectorEventDetail,
  listenForConnectRequests,
  listenForNavigateViewRequests,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
  NAVIGATE_VIEW_EVENT,
  NETWORK_STATUS_CHANGE_EVENT,
  PUSH_TO_TALK_HOLD_EVENT,
  PUSH_TO_TALK_TOGGLE_EVENT,
  SHARE_TARGET_EVENT,
  TRAY_ACTION_EVENT,
  useViewEvent,
  VIEW_EVENTS,
} from "./events/index.js";
export {
  clearPendingRemoteFirstRun,
  completeRemoteAgentFirstRun,
} from "./first-run/adopt-remote-first-run.js";
export { tryHandleBootRecoveryAction } from "./first-run/boot-recovery-channel.js";
export { clearFirstRunTranscriptMessages } from "./first-run/clear-first-run-transcript.js";
export {
  armCloudLoginWaitDeadline,
  createAttemptGuard,
} from "./first-run/cloud-login-wait-deadline.js";
export {
  parseFirstRunRemoteConnectDeepLink,
  routeFirstRunDeepLink,
} from "./first-run/deep-link-handler.js";
export {
  enforceDeviceRamPolicyOnPersistedRuntimeModeAtBoot,
  peekDeviceRamTierAssessment,
  resolveDeviceRamTierAssessment,
} from "./first-run/device-ram-gate.js";
export {
  type DeviceRamTierAssessment,
  HYBRID_AGENT_MIN_MARKETED_RAM_GB,
  LOCAL_AGENT_MIN_MARKETED_RAM_GB,
} from "./first-run/device-ram-tier.js";
export { normalizeFirstRunName } from "./first-run/first-run.js";
export {
  classifyActionMessage,
  FIRST_RUN_ACTION_PREFIX,
  FIRST_RUN_CLOUD_LOGIN_ACTION,
  getFirstRunCloudLoginFallbackPath,
  setFirstRunActionHandler,
  setFirstRunTextHandler,
  tryHandleFirstRunAction,
  tryHandleFirstRunText,
} from "./first-run/first-run-action-channel.js";
export {
  clearCloudLoginPending,
  markCloudLoginPending,
  readCloudLoginPending,
} from "./first-run/first-run-cloud-resume.js";
export {
  bindCloudAgent,
  type FirstRunFinishDraft,
  type FirstRunFinishOutcome,
  type FirstRunFinishPorts,
  listOrAutoProvisionCloudAgent,
  resetFirstRunPersistGuard,
  runFirstRunFinish,
} from "./first-run/first-run-finish.js";
export {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "./first-run/first-run-greeting.js";
export {
  handoffPendingFirstRunText,
  readPendingFirstRunText,
  setPendingFirstRunTextReleaseHandler,
  writePendingFirstRunText,
} from "./first-run/first-run-pending-text.js";
export { isRuntimeChooserEnabled } from "./first-run/first-run-runtime-flag.js";
export { isAndroidLocalAgentUrl } from "./first-run/local-agent-token.js";
export {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  IOS_LOCAL_AGENT_IPC_BASE,
  isCommittedOnDeviceMobileRuntimeMode,
  isElizaCloudRuntimeLocked,
  isMobileLocalAgentIpcBase,
  isMobileLocalAgentIpcUrl,
  isMobileLocalAgentUrl,
  MOBILE_LOCAL_AGENT_API_BASE,
  MOBILE_LOCAL_AGENT_IPC_BASE,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_PORT,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
  mobileLocalAgentPathFromUrl,
  normalizeMobileRuntimeMode,
  persistMobileRuntimeMode,
  persistMobileRuntimeModeForServerTarget,
  readPersistedMobileRuntimeMode,
} from "./first-run/mobile-runtime-mode.js";
export { tryHandleModelAction } from "./first-run/model-action-channel.js";
export { preSeedAndroidLocalRuntimeIfFresh } from "./first-run/pre-seed-local-runtime.js";
export {
  readMobileRuntimeBuildTruth,
  reconcilePersistedMobileRuntimeModeAtBoot,
} from "./first-run/reconcile-mobile-runtime-mode.js";
export { revertLocalRuntimeCommitment } from "./first-run/revert-local-runtime-commitment.js";
export {
  activeServerKindToFirstRunRuntimeTarget,
  type FirstRunRuntimeTarget,
} from "./first-run/runtime-target.js";
export { BootRecoveryConductorMount } from "./first-run/use-boot-recovery-conductor.js";
export { ModelStatusConductorMount } from "./first-run/use-model-status-conductor.js";
export { GlassStyles } from "./glass/GlassSurface.js";
export { BugReportProvider } from "./hooks/BugReportProvider.js";
export {
  type CachedSnapshot,
  getCached,
  getRevalidationError,
  invalidate,
  revalidate,
  setCached,
  startPolling,
  subscribe,
} from "./hooks/resource-cache.js";
export {
  isCapabilityWarmupAbort,
  loadAfterCapabilityWarmup,
  useAbortableCapabilityWarmup,
} from "./hooks/runtime-capability-retry.js";
export {
  getActiveAgentAuthority,
  useActiveAgentAuthority,
} from "./hooks/useActiveAgentAuthority.js";
export {
  type ActivityEvent,
  useActivityEvents,
} from "./hooks/useActivityEvents.js";
export { useAgentSessionRecovery } from "./hooks/useAgentSessionRecovery.js";
export {
  type AuthStatusState,
  getAuthStatusSnapshot,
  isAuthenticatedNow,
  primeAuthStatusProbe,
  subscribeAuthStatus,
  useAuthStatus,
} from "./hooks/useAuthStatus.js";
export {
  useAvailableViews,
  useRoutableViews,
  type ViewRegistryEntry,
} from "./hooks/useAvailableViews.js";
export { useBugReportState } from "./hooks/useBugReport.hooks.js";
export { useContextMenu } from "./hooks/useContextMenu.js";
export { useDesktopTabs } from "./hooks/useDesktopTabs.js";
export { useSecretsManagerModalState } from "./hooks/useSecretsManagerModal.js";
export { useSecretsManagerShortcut } from "./hooks/useSecretsManagerShortcut.js";
export { useVoiceChat } from "./hooks/useVoiceChat.js";
export { createTranslator } from "./i18n/index.js";
export {
  FramedPage,
  FramedPageBody,
} from "./layouts/framed-page.js";
export { PageFrame } from "./layouts/page-frame.js";
export { cn } from "./lib/utils.js";
export { logger } from "./logger.js";
export { LoginAuthGuard } from "./login/components/LoginAuthGuard.js";
export type { LoginConnectOrCreateWalletProps } from "./login/components/LoginConnectOrCreateWallet.js";
export { LoginEmailCallback } from "./login/components/LoginEmailCallback.js";
export {
  LoginForm,
  PASSKEY_ENROLL_PROMPT_KEY,
} from "./login/components/LoginForm.js";
export type {
  LoginFormWithWalletsEvmConfig,
  LoginFormWithWalletsProps,
  LoginFormWithWalletsSolanaConfig,
} from "./login/components/LoginFormWithWallets.js";
export { LoginLinkedAccounts } from "./login/components/LoginLinkedAccounts.js";
export { LoginMfaChallenge } from "./login/components/LoginMfaChallenge.js";
export { LoginMfaSettings } from "./login/components/LoginMfaSettings.js";
export { LoginOAuthCallback } from "./login/components/LoginOAuthCallback.js";
export { LoginTenantPicker } from "./login/components/LoginTenantPicker.js";
export { LoginUserButton } from "./login/components/LoginUserButton.js";
export { PasskeyEnrollmentPrompt } from "./login/components/PasskeyEnrollmentPrompt.js";
export type {
  WalletChains,
  WalletLoginClassOverrides,
  WalletLoginProps,
} from "./login/components/WalletLogin.js";
export { useAuth } from "./login/hooks/useAuth.js";
export { useMfaStepUp } from "./login/hooks/useMfaStepUp.js";
export { DiscordIcon, GoogleIcon } from "./login/icons/index.js";
export {
  LoginProvider,
  type LoginProviderWithAuthProps,
  useLogin,
} from "./login/provider.js";
export type {
  CreateDefaultWagmiConfigOptions,
  DefaultWagmiChains,
  EVMWalletProviderProps,
} from "./login/providers/EVMProvider.js";
export type { SolanaWalletProviderProps } from "./login/providers/SolanaProvider.js";
export type {
  LoginAuthConfig,
  LoginAuthContextValue,
  LoginAuthGuardProps,
  LoginContextValue,
  LoginEmailCallbackProps,
  LoginFormProps,
  LoginLinkedAccountsProps,
  LoginMfaChallengeProps,
  LoginMfaSettingsProps,
  LoginOAuthCallbackProps,
  LoginProviderProps,
  LoginTenantPickerProps,
  LoginUserButtonProps,
  TenantTheme,
} from "./login/types.js";
export {
  createDefaultWagmiConfig,
  EVMWalletProvider,
  LoginConnectOrCreateWallet,
  LoginFormWithWallets,
  SolanaWalletProvider,
  WalletLogin,
} from "./login/wallet/index.js";
export {
  acceptNativeTranscriptViewModel,
  type NativeTranscriptViewSource,
} from "./native-transcript/live-store.js";
export { NATIVE_TRANSCRIPT_RENDERER_EVENT } from "./native-transcript/transport.js";
export {
  APPS_ENABLED,
  getAppSlugFromPath,
  getWindowNavigationPath,
  isAospShellEnabled,
  isAppWindowRoute,
  isDeveloperWorkspaceRoute,
  isRouteRootPath,
  NATIVE_OS_VIEW_IDS,
  pathForTab,
  resolveBuiltinRouteDescriptor,
  resolveDefaultLandingTab,
  resolveInitialTabForPath,
  shouldUseHashNavigation,
  TAB_PATHS,
  type Tab,
  tabFromPath,
  titleForTab,
} from "./navigation/index.js";
export { isAndroidCloudBuild } from "./platform/android-runtime.js";
export {
  type AppShellMode,
  resolveAppShellMode,
} from "./platform/app-shell-mode.js";
export {
  BrowserDocumentConflict,
  type BrowserDocumentSnapshot,
  BrowserDocumentStore,
} from "./platform/browser-document-store.js";
export {
  applyLaunchConnection,
  applyLaunchConnectionFromUrl,
} from "./platform/browser-launch.js";
export { installLocalProviderCloudPreferencePatch } from "./platform/cloud-preference-patch.js";
export { installDesktopPermissionsClientPatch } from "./platform/desktop-permissions-client.js";
export {
  applyForceFreshFirstRunReset,
  clearForceFreshFirstRun,
  installForceFreshFirstRunClientPatch,
  isForceFreshFirstRunEnabled,
  wasForceFreshResetApplied,
} from "./platform/first-run-reset.js";
export {
  isAndroid,
  isElizaOS,
  isIOS,
  isNative,
  isStandalonePwa,
  type ShareTargetPayload,
} from "./platform/init.js";
export {
  apiBaseToDeviceBridgeUrl,
  DEFAULT_ELIZA_CLOUD_BASE,
  type IosRuntimeConfig,
  type IosRuntimeMode,
  resolveCloudApiBase,
  resolveIosRuntimeConfig,
  resolveMobileApiConnection,
} from "./platform/ios-runtime.js";
export { isCapacitorNativeRuntime } from "./platform/native-probe.js";
export {
  armOnboardingReplay,
  isOnboardingReplayRequested,
  type OnboardingReplayHandle,
} from "./platform/onboarding-replay.js";
export {
  getFrontendPlatform,
  isDynamicViewLoadingAllowed,
} from "./platform/platform-guards.js";
export {
  exchangeRemoteAgentPairing,
  parseRemoteAgentPairingDeepLink,
  RemoteAgentPairingError,
} from "./platform/remote-agent-pairing.js";
export {
  acknowledgeRemoteCommandEnqueue,
  clearRemoteControllerSessionState,
  createRemoteCommand,
  getOrCreateRemoteControllerIdentity,
  openRemoteCommandResult,
  openRemoteCommandStartReceipt,
} from "./platform/remote-controller.js";
export {
  activateRemoteTarget,
  compensateRemoteTargetActivation,
  confirmRemoteTargetPairing,
  createRemoteTargetPairingChallenge,
  enrollRemoteTarget,
  finalizeRemoteTargetHostRevoke,
  getRemoteTargetIdentity,
  getRemoteTargetStatus,
  startRemoteTarget,
  stopRemoteTarget,
  supportsNativeRemoteTarget,
} from "./platform/remote-target.js";
export {
  dispatchRemoteControllerPairingIntent,
  parseRemoteControllerPairingDeepLink,
} from "./platform/remote-target-pairing-intent.js";
export {
  type RendererShellKind,
  registerRendererService,
  startRendererServiceHost,
} from "./platform/renderer-services.js";
export {
  deleteRuntimeCredentialRecord,
  storeRuntimeCredential,
} from "./platform/runtime-credential-store.js";
export {
  configureRuntimeManagement,
  type LocalRuntimeManagementRequest,
} from "./platform/runtime-management.js";
export {
  inspectSshHost,
  requestSshRuntime,
  startSshRuntime,
  stopSshRuntime,
} from "./platform/ssh-runtime.js";
export {
  removeSshRuntime,
  resumePendingSshRuntimeCleanups,
  retrySshRuntimeCleanup,
  type SshRuntimeCleanupResult,
  type SshRuntimeLifecycleDependencies,
  setupSshRuntime,
} from "./platform/ssh-runtime-lifecycle.js";
export {
  clearStandaloneBottomReclaim,
  installStandaloneBottomReclaim,
  shouldInstallStandaloneBottomReclaim,
} from "./platform/standalone-bottom-reclaim.js";
export type { FirstRunClientLike } from "./platform/types.js";
export { isViteDevUiShell } from "./platform/vite-dev-ui-shell.js";
export {
  isChatOverlayWindowShell,
  isDetachedWindowShell,
  isStandaloneWindowShell,
  resolveDetachedShellTarget,
  resolveWindowShellRoute,
  shouldInstallMainWindowFirstRunPatches,
  syncDetachedShellLocation,
  type WindowShellRoute,
} from "./platform/window-shell.js";
export { RetainedLazyComponent } from "./retained-lazy.js";
export { routedShellMainClass } from "./routed-shell-layout.js";
export {
  CodingAgentSettingsSection,
  registerTaskCoordinatorSlots,
  type TaskCoordinatorCodingAgentControlChipProps,
  type TaskCoordinatorCodingAgentSettingsSectionProps,
  type TaskCoordinatorCodingAgentTasksPanelProps,
  type TaskCoordinatorPtyConsoleBaseProps,
} from "./slots/task-coordinator-slots.js";
export { SpatialSurface } from "./spatial/dom.js";
export type { SpatialTone } from "./spatial/ir.js";
export {
  Button as SpatialButton,
  Card as SpatialCard,
  Divider as SpatialDivider,
  Escape,
  Field,
  HStack as SpatialHStack,
  List as SpatialList,
  Spacer,
  Text as SpatialText,
  VStack as SpatialVStack,
} from "./spatial/primitives.js";
export { dispatchConversationResync } from "./state/AppContext.hooks.js";
export {
  type ActionNotice,
  type ActionTone,
  TOAST_TTL_MS,
} from "./state/action-notice.js";
export { scrubRevokedRemoteCredential } from "./state/active-server-credential.js";
export { applyAgentProfileConnection } from "./state/agent-profile-connection.js";
export type {
  AgentProfile,
  AgentProfileRegistry,
} from "./state/agent-profile-types.js";
export {
  activeServerIdForAgentProfile,
  addAgentProfile,
  getActiveProfile,
  loadAgentProfileRegistry,
  persistAgentProfileSelection,
  removeAgentProfile,
  resolveAgentProfileByQuery,
  saveAgentProfileRegistry,
  upsertAndActivateAgentProfile,
} from "./state/agent-profiles.js";
export {
  resolveDedicatedAgentId,
  shouldShowCloudAgentReauthNotice,
} from "./state/agent-session-recovery.js";
export {
  computeAgentDeadlineExtensions,
  getAgentReadyTimeoutMs,
} from "./state/agent-startup-timing.js";
export {
  publishAppValue,
  seedAppValue,
  useAppSelector,
  useAppSelectorShallow,
} from "./state/app-store.js";
export {
  ChatComposerCtx,
  ChatInputRefCtx,
  clearAllChatDrafts,
  useChatComposer,
  useChatComposerDraftPersistence,
  useChatInputRef,
} from "./state/ChatComposerContext.hooks.js";
export { ChatTurnStatusCtx } from "./state/ChatTurnStatusContext.hooks.js";
export {
  ConversationMessagesCtx,
  useConversationMessages,
} from "./state/ConversationMessagesContext.hooks.js";
export {
  clearCloudAuthFirstScreenGreeting,
  consumeCloudAuthFirstScreenGreeting,
  markCloudAuthFirstScreenGreeting,
} from "./state/cloud-auth-first-screen.js";
export { cloudAuthFirstScreenOwnsHost } from "./state/cloud-auth-first-screen-policy.js";
export {
  claimCloudLoginWindow,
  prepareDesktopCloudLoginSession,
  releaseClaimedCloudLoginWindow,
} from "./state/cloud-login-launch.js";
export { hasUsableStoredStewardToken } from "./state/cloud-steward-login.js";
export {
  describeStoppedDedicatedCloudAgent,
  isTerminalDedicatedCloudAgentErrorState,
} from "./state/dedicated-cloud-agent-error.js";
export {
  type DesktopLauncherEntry,
  type DesktopLauncherIconId,
  setDesktopLauncherEntries,
} from "./state/desktop-tray-launcher.js";
export {
  detectExistingFirstRunConnection,
  type ExistingFirstRunProbeResult,
} from "./state/first-run-bootstrap.js";
export { isAuthoritativeFirstRunOpen } from "./state/first-run-chat-release.js";
export {
  createFirstRunTranscriptEpoch,
  observeFirstRunTranscriptEpoch,
} from "./state/first-run-transcript-epoch.js";
export {
  type NotificationChatRequest,
  readNotificationChatTarget,
} from "./state/notifications/navigate-deep-link.js";
export { initOcrBridge } from "./state/ocr-bridge.js";
export { PtySessionsCtx } from "./state/PtySessionsContext.hooks.js";
export {
  asApiLikeError,
  formatStartupErrorDetail,
  parseAgentStatusEvent,
  parseProactiveMessageEvent,
  parseStreamEventEnvelopeEvent,
} from "./state/parsers.js";
export {
  applyAppTheme,
  clearPersistedActiveServer,
  createPersistedActiveServer,
  hydratePersistedFirstRunCompleteFromNativeStore,
  loadAvatarIndex,
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
  loadUiLanguage,
  type PersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "./state/persistence.js";
export { getPushToTalkAccelerator } from "./state/push-to-talk-hotkey.js";
export { removeProfileWithoutStaleSelection } from "./state/runtime-profile-removal.js";
export {
  installBuildConfiguredRemoteApiBaseUrl,
  isLoopbackHostname,
  isTrustedBuildConfiguredRemoteApiBaseUrl,
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "./state/runtime-url-trust.js";
export { initScreenCaptureBridge } from "./state/screen-capture-bridge.js";
export { deriveFirstRunResumeFieldsFromConfig } from "./state/setup-resume.js";
export { clearSharedCloudAccountBinding } from "./state/shared-cloud-account-binding.js";
export { deriveUiShellModeForTab } from "./state/shell-routing.js";
export type { RuntimeTarget } from "./state/startup-coordinator.js";
export {
  createDesktopPolicy,
  createElizaOSPolicy,
  createMobilePolicy,
  createNativeLocalRuntimePolicy,
  createWebPolicy,
  getStartupStatusMessageKey,
  INITIAL_STARTUP_STATE,
  isShellPaintable,
  isStartupInteractive,
  isStartupLoading,
  isStartupTerminal,
  type PlatformPolicy,
  type StartupEvent,
  type StartupState,
  type StartupStatusMessageKey,
  startupReducer,
} from "./state/startup-coordinator.js";
export { buildStaticFirstRunOptions } from "./state/startup-first-run-options.js";
export {
  runStartupProbe,
  runStartupProbeWithTimeout,
  unwrapStartupProbe,
} from "./state/startup-probe.js";
export { createStartupRecoveryLoop } from "./state/startup-recovery-loop.js";
export {
  initStartupTrace,
  markStartup,
  measureStartup,
} from "./state/startup-telemetry.js";
export { STARTUP_TIMING_POLICY } from "./state/startup-timing-policy.js";
export { switchRuntimeNonDestructive } from "./state/switch-runtime.js";
export { useTranslation } from "./state/TranslationContext.hooks.js";
export { TranslationProvider } from "./state/TranslationProvider.js";
export {
  authProbeShouldHoldShell,
  firstRunOwnsLoginSurface,
  shouldShowRemoteAgentPairingGate,
  topLevelAuthGateOwnsSurface,
} from "./state/top-level-auth-gate.js";
export type {
  AppContextValue,
  AppState,
  InventoryChainFilters,
  LoadConversationMessagesResult,
  StartupErrorReason,
  StartupErrorState,
  WalletResourceStatus,
} from "./state/types.js";
export { ACCENT_PRESETS } from "./state/ui-preferences.js";
export { useFirstRunChatRelease } from "./state/use-first-run-chat-release.js";
export { useRemoteConnectRequests } from "./state/use-remote-connect-requests.js";
export { isBootstrapGateRequired } from "./state/use-startup-shell-controller.js";
export { AppContext, useApp } from "./state/useApp.js";
export { useAppLifecycleEvents } from "./state/useAppLifecycleEvents.js";
export {
  useAgentGreetingEffects,
  useBackendConnectionSync,
  useNavigationPathSync,
} from "./state/useAppProviderEffects.js";
export { useAppShellState } from "./state/useAppShellState.js";
export { useCharacterState } from "./state/useCharacterState.js";
export { useChatCallbacks } from "./state/useChatCallbacks.js";
export { getChatOverlayHotkey } from "./state/useChatOverlayHotkey.js";
export { useChatState } from "./state/useChatState.js";
export { useCloudState } from "./state/useCloudState.js";
export { useDataLoaders } from "./state/useDataLoaders.js";
export { DeveloperTabHost } from "./state/useDeveloperTabHost.js";
export { useDisplayPreferences } from "./state/useDisplayPreferences.js";
export { useExportImportState } from "./state/useExportImportState.js";
export { useFirstRunCallbacks } from "./state/useFirstRunCallbacks.js";
export { useFirstRunState } from "./state/useFirstRunState.js";
export { useLifecycleState } from "./state/useLifecycleState.js";
export { useLogsState } from "./state/useLogsState.js";
export { useMiscUiState } from "./state/useMiscUiState.js";
export { useNavigationState } from "./state/useNavigationState.js";
export { usePairingState } from "./state/usePairingState.js";
export { usePluginsSkillsState } from "./state/usePluginsSkillsState.js";
export { useResyncReconcile } from "./state/useResyncReconcile.js";
export { useTabSync } from "./state/useTabSync.js";
export { useTriggersState } from "./state/useTriggersState.js";
export { useEnabledViewKinds } from "./state/useViewKinds.js";
export { useWalletState } from "./state/useWalletState.js";
export { useRegisterViewChatBinding } from "./state/view-chat-binding.js";
export { normalizeAvatarIndex } from "./state/vrm.js";
export {
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "./surface-realm-broker.js";
export { shellHistory, shellLocalStorage } from "./surface-realm-channel.js";
export { applyThemeToDocument } from "./themes/apply-theme.js";
export { ELIZA_DEFAULT_THEME } from "./themes/presets.js";
export {
  buildTutorialActionValue,
  setTutorialActionHandler,
  setTutorialTextHandler,
  type TutorialAction,
  type TutorialCommand,
  tryHandleTutorialAction,
  tryHandleTutorialText,
} from "./tutorial/tutorial-action-channel.js";
export {
  buildTutorialScript,
  type TutorialScriptStep,
  type TutorialStepCompletion,
} from "./tutorial/tutorial-script.js";
export {
  advanceTutorial,
  getTutorialState,
  restartTutorial,
  startTutorial,
  stopTutorial,
  useTutorial,
} from "./tutorial/tutorial-service.js";
export { resolveAppAssetUrl } from "./utils/asset-url.js";
export { safeAttachmentUrl } from "./utils/attachment-url.js";
export { copyTextToClipboard } from "./utils/clipboard.js";
export {
  buildCloudSharedAgentApiBase,
  buildDedicatedCloudAgentApiBase,
  dedicatedCloudAgentIdFromBase,
  isDedicatedCloudAgentBase,
  isElizaCloudControlPlaneAgentlessBase,
  isManagedCloudSharedAgentBase,
  isPersonalSharedElizaId,
  isTrustedHostedCloudOnboardingBase,
  resolveCloudEnvironmentBase,
} from "./utils/cloud-agent-base.js";
export { isCloudStatusReasonApiKeyOnly } from "./utils/cloud-status.js";
export { confirmDesktopAction } from "./utils/desktop-dialogs.js";
export {
  type DesktopClickAuditItem,
  loadDesktopWorkspaceSnapshot,
  openDesktopSettingsWindow,
  openDesktopWorkspaceWindow,
} from "./utils/desktop-workspace.js";
export {
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "./utils/documents-upload-image.js";
export {
  canShareFiles,
  downloadAttachment,
  filenameForMime,
  shareAttachment,
} from "./utils/download-share.js";
export { formatByteSize } from "./utils/format.js";
export {
  createValidatedJsonStorage,
  type JsonStoragePort,
} from "./utils/json-storage.js";
export { isSafeNavigationUrl } from "./utils/navigation-url.js";
export { openExternalUrl } from "./utils/openExternalUrl.js";
export { reportRendererDiagnostic } from "./utils/renderer-diagnostics.js";
export {
  editTextControl,
  isEditableTextControl,
  type TextControl,
  type TextControlEdit,
} from "./utils/text-control-editing.js";
export { isTransientOptionalFetchFailure } from "./utils/transient-fetch.js";
export {
  formatMinorCurrency,
  isIsoCalendarDate,
  isOrderedIsoDateRange,
  type MinorCurrencyValue,
} from "./utils/value-formatting";
export { recoverMissedCurrentView } from "./view-action-handoff.js";
export {
  loadAppWindowRenderer,
  loadAutomationsFeed,
  loadBackgroundView,
  loadBrowserWorkspaceView,
  loadCameraPageView,
  loadCharacterEditor,
  loadCharacterExperienceView,
  loadCharacterSkillsView,
  loadChatView,
  loadCloudRouterShell,
  loadContextInspectorView,
  loadConversationsSidebar,
  loadDatabasePageView,
  loadDesktopWorkspaceSection,
  loadDeveloperWorkspace,
  loadFilesView,
  loadLiveMeetingPage,
  loadLogsView,
  loadManagedCloudPage,
  loadMemoryViewerView,
  loadNativeAppsStudio,
  loadPluginsPageView,
  loadRemoteControlCloudDefault,
  loadRuntimeView,
  loadSecretsManagerSection,
  loadSettingsView,
  loadShellViewAgentSurface,
  loadSkillsView,
  loadStreamView,
  loadTasksPageView,
  loadTrajectoriesView,
  loadTriggersView,
  loadVaultPageView,
  loadViewInteractRegistry,
  loadVoiceBootstrap,
  loadWebAppsStudio,
} from "./view-loaders.js";
export { emitViewEvent } from "./views/view-event-bus.js";
export {
  playCaptureSendCue,
  playCaptureStartCue,
} from "./voice/capture-cues.js";
export {
  DeviceSpeechController,
  type DeviceSpeechEnvironment,
  type DeviceSpeechState,
} from "./voice/device-speech-controller.js";
export {
  DraftTranscriptGuard,
  type DraftTranscriptResult,
} from "./voice/draft-transcript-guard.js";
export {
  audioBlobBase64,
  type CumulativeCaptureOptions,
  observeMicrophonePause,
  type SpeechPauseOptions,
  startCumulativeMicrophoneCapture,
} from "./voice/microphone-capture.js";
export {
  encodeMonoPcm16Wav,
  encodeMonoPcm16WavChunks,
} from "./voice/pcm-wave.js";
export {
  RecordedTranscriptionController,
  RecordedTranscriptionError,
  type RecordedTranscriptionOptions,
  type RecordedTranscriptionState,
  type RecordingPhase,
} from "./voice/recorded-transcription-controller.js";
export {
  type SegmentedSpeechOptions,
  SegmentedSpeechPlayback,
  type SegmentedSpeechState,
  type SpeechAudioEnvironment,
  SpeechPlaybackError,
} from "./voice/segmented-speech-playback.js";
export { splitSpeechSegments } from "./voice/speech-segments.js";
export { useVoiceConfig } from "./voice/useVoiceConfig.js";
export {
  createVoiceCapture,
  type VoiceCaptureFactoryOptions,
  type VoiceCaptureHandle,
} from "./voice/voice-capture-factory.js";
export { isCloudVoiceRunnable } from "./voice/voice-provider-defaults.js";
export {
  EXPECTED_PHRASE,
  KNOWN_PHRASE_WAV_DATA_URL,
} from "./voice/voice-selftest/known-phrase.js";
export { VoiceSelfTestShell } from "./voice/voice-selftest/VoiceSelfTestShell.js";
export { VoiceWorkbenchShell } from "./voice/voice-selftest/VoiceWorkbenchShell.js";
export {
  runVoiceSelfTest,
  type VoiceSelfTestReport,
} from "./voice/voice-selftest/voice-selftest-harness.js";
export { registerBuiltinWidgets } from "./widgets/registry.js";
export { WidgetHost } from "./widgets/WidgetHost.js";
