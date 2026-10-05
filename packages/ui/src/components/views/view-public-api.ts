/** Explicit view-facing APIs. Host bootstrap and realm ownership are not available to view bundles. */
export { useAgentElement } from "../../agent-surface/useAgentElement.js";
export { client, ElizaClient } from "../../api/client";
export {
  ApiError,
  isApiError,
  isCloudAgentGoneError,
  isRateLimitedError,
} from "../../api/client-types-core";
export { fetchWithCsrf } from "../../api/csrf-client.js";
export { BRAND_PATHS, EXTERNAL_URLS, LOGO_FILES } from "../../brand/index.js";
export {
  mapServerTasksToSessions,
  PULSE_STATUSES,
  STATUS_DOT,
  TERMINAL_STATUSES,
} from "../../chat/index.js";
export { NAVIGATE_SETTINGS_EVENT } from "../../chat/shortcut-report.js";
export {
  reportUserViewClosed,
  reportUserViewSwitch,
  shouldClearReportedView,
} from "../../chat/view-navigation-report.js";
export { AccountList } from "../../components/accounts/AccountList.js";
export {
  AppWindowRenderer,
  OverlayAppSurface,
} from "../../components/apps/AppWindowRenderer.js";
export {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "../../components/apps/extensions/surface.helpers.js";
export {
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
} from "../../components/apps/extensions/surface.js";
export { GameViewOverlay } from "../../components/apps/GameViewOverlay.js";
export { AgentAuthGateSurface } from "../../components/auth/AgentAuthGateSurface.js";
export {
  CloudPairRelay,
  getCloudPairTokenFromLocation,
  isElizaCloudHostedLocation,
  resolveCloudHostedAgentUrl,
} from "../../components/auth/CloudPairRelay.js";
export {
  CharacterSectionNav,
  isCharacterSectionPath,
} from "../../components/character/CharacterSectionNav.js";
export { OrchestratorAccountsView } from "../../components/chat/widgets/agent-orchestrator-accounts-view.js";
export { OrchestratorTaskWidget } from "../../components/chat/widgets/orchestrator-task-widget.js";
export {
  EmptyWidgetState,
  WidgetSection,
} from "../../components/chat/widgets/shared.js";
export { registerTaskWidget } from "../../components/chat/widgets/task-widget.js";
export { CockpitTierToggle } from "../../components/cockpit/CockpitTierToggle.js";
export { CockpitView } from "../../components/cockpit/CockpitView.js";
export { ELIZA_CLOUD_TIER_MODEL } from "../../components/cockpit/cockpit-modes.js";
export {
  PageLoadingState,
  PagePanel,
} from "../../components/composites/page-panel/index.js";
export { CustomActionEditor } from "../../components/custom-actions/CustomActionEditor.js";
export { CustomActionsPanel } from "../../components/custom-actions/CustomActionsPanel.js";
export { TaskChoice } from "../../components/interactive-task/TaskChoice.js";
export { AppsPageView } from "../../components/pages/AppsPageView.js";
export { LauncherSurface } from "../../components/pages/LauncherSurface.js";
export { PluginPageFrame } from "../../components/pages/PluginPageFrame.js";
export { PluginsPageView } from "../../components/pages/PluginsPageView.js";
export {
  isWalletSectionPath,
  WalletSectionNav,
} from "../../components/pages/WalletSectionNav.js";
export { PermissionPrimingOverlay } from "../../components/permissions/PermissionPrimingOverlay.js";
export { PermissionRecoveryCallout } from "../../components/permissions/PermissionRecoveryCallout.js";
export { ShellModalityProvider } from "../../components/ShellModalityProvider.js";
export { ShellRoleProvider } from "../../components/ShellRoleProvider.js";
export {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../components/settings/settings-layout.js";
export { ActionListRow } from "../../components/shared/ActionListRow.js";
export { AppPageSidebar } from "../../components/shared/AppPageSidebar.js";
export { ConfirmDeleteControl } from "../../components/shared/confirm-delete-control.js";
export {
  SectionNav,
  SectionTabStrip,
} from "../../components/shared/SectionNav.js";
export {
  ViewBackButton,
  ViewHeader,
} from "../../components/shared/ViewHeader.js";
export { ActionNoticeToast } from "../../components/shell/ActionNoticeToast.js";
export { AssistantOverlay } from "../../components/shell/AssistantOverlay.js";
export { BugReportModal } from "../../components/shell/BugReportModal.js";
export { BuildBadge } from "../../components/shell/BuildBadge.js";
export { ChatOverlay } from "../../components/shell/ChatOverlay.js";
export { ChatSurface } from "../../components/shell/ChatSurface.js";
export { CloudSignInRecoveryView } from "../../components/shell/CloudSignInRecoveryView.js";
export { ConnectionLostOverlay } from "../../components/shell/ConnectionLostOverlay.js";
export { DynamicPluginFallback } from "../../components/shell/DynamicPluginFallback.js";
export { HomeLauncherSurface } from "../../components/shell/HomeLauncherSurface.js";
export { HomePill } from "../../components/shell/HomePill.js";
export { HomeScreen } from "../../components/shell/HomeScreen.js";
export { initializeIosKeyboardAccessoryBar } from "../../components/shell/ios-chat-accessory-bar.js";
export { KioskViewCanvas } from "../../components/shell/KioskViewCanvas.js";
export {
  NotificationsDataBoot,
  NotificationsShellBoot,
} from "../../components/shell/notifications-boot.js";
export { PairingView } from "../../components/shell/PairingView.js";
export { useShellControllerContext } from "../../components/shell/ShellControllerContext.hooks.js";
export { ShellOverlays } from "../../components/shell/ShellOverlays.js";
export { StartupFailureView } from "../../components/shell/StartupFailureView.js";
export { StartupScreen } from "../../components/shell/StartupScreen.js";
export { StartupShell } from "../../components/shell/StartupShell.js";
export { SystemWarningBanner } from "../../components/shell/SystemWarningBanner.js";
export { TrayLauncher } from "../../components/shell/TrayLauncher.js";
export { useBarSurfaceWindows } from "../../components/shell/useBarSurfaceWindows.js";
export { useKioskViewSurfaces } from "../../components/shell/useKioskViewSurfaces.js";
export { VoiceCaptureHud } from "../../components/shell/VoiceCaptureHud.js";
export { TranscriptPlayer } from "../../components/transcripts/TranscriptPlayer.js";
export { ArtifactPrivacyControls } from "../../components/transcripts/TranscriptsView.js";
export {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../components/ui/alert.js";
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
} from "../../components/ui/alert-dialog.js";
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
} from "../../components/ui/attachment.js";
export {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "../../components/ui/avatar.js";
export { Badge, badgeVariants } from "../../components/ui/badge.js";
export { Button, buttonVariants } from "../../components/ui/button.js";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cardVariants,
} from "../../components/ui/card.js";
export { Checkbox } from "../../components/ui/checkbox.js";
export { CodeBlock } from "../../components/ui/code-block.js";
export {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible.js";
export {
  useConfirm,
  usePrompt,
} from "../../components/ui/confirm-dialog.hooks.js";
export {
  ConfirmDialog,
  PromptDialog,
} from "../../components/ui/confirm-dialog.js";
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
} from "../../components/ui/dialog.js";
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
} from "../../components/ui/dropdown-menu.js";
export {
  ErrorBoundary,
  ErrorBoundaryFallback,
} from "../../components/ui/error-boundary.js";
export { FormSelect, FormSelectItem } from "../../components/ui/form-select.js";
export { Grid } from "../../components/ui/grid.js";
export { Input, inputVariants } from "../../components/ui/input.js";
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
  inputGroupVariants,
} from "../../components/ui/input-group.js";
export { Label } from "../../components/ui/label.js";
export {
  Marker,
  MarkerContent,
  MarkerIcon,
  markerVariants,
} from "../../components/ui/marker.js";
export {
  Message,
  MessageAvatar,
  MessageContent as MessageRowContent,
  MessageFooter,
  MessageGroup,
  MessageHeader,
} from "../../components/ui/message.js";
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
} from "../../components/ui/message-scroller.js";
export { NativeDialog } from "../../components/ui/native-dialog.js";
export {
  NativeSelect,
  nativeSelectVariants,
} from "../../components/ui/native-select.js";
export {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover.js";
export { Progress } from "../../components/ui/progress.js";
export { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
export { SegmentedControl } from "../../components/ui/segmented-control.js";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
export { SemanticForm } from "../../components/ui/semantic-form.js";
export { Separator } from "../../components/ui/separator.js";
export {
  SettingsControls,
  SettingsField,
  SettingsFieldDescription,
  SettingsFieldLabel,
  SettingsInput,
  SettingsMutedText,
  SettingsSegmentedGroup,
  SettingsSelectTrigger,
  SettingsTextarea,
} from "../../components/ui/settings-controls.js";
export { Skeleton } from "../../components/ui/skeleton.js";
export {
  CompactCardSkeleton,
  DetailSkeleton,
  ListSkeleton,
  TableSkeleton,
} from "../../components/ui/skeleton-layouts.js";
export { Slider } from "../../components/ui/slider.js";
export { Spinner } from "../../components/ui/spinner.js";
export { Stack } from "../../components/ui/stack.js";
export {
  StatusBadge,
  StatusDot,
  StatusPulseDot,
} from "../../components/ui/status-badge.js";
export { Switch } from "../../components/ui/switch.js";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../components/ui/tabs.js";
export { TagEditor } from "../../components/ui/tag-editor.js";
export { TextLink, textLinkVariants } from "../../components/ui/text-link.js";
export { Textarea, textareaVariants } from "../../components/ui/textarea.js";
export {
  Tooltip,
  TooltipContent,
  TooltipHint,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";
export { Heading, Text } from "../../components/ui/typography.js";
export { DynamicViewLoader } from "../../components/views/DynamicViewLoader.js";
export { registerDeviceControlInteractHandler } from "../../components/views/device-control-interact.js";
export { KeepAliveViewHost } from "../../components/views/KeepAliveViewHost.js";
export { ShellViewAgentSurface } from "../../components/views/ShellViewAgentSurface.js";
export { registerSandboxProbeView } from "../../components/views/sandbox-probe-view.js";
export { ViewErrorBoundary } from "../../components/views/ViewErrorBoundary.js";
export { ViewUnavailableState } from "../../components/views/ViewStatusStates.js";
export { AppWorkspaceChrome } from "../../components/workspace/AppWorkspaceChrome.js";
export { AppWorkspaceContent } from "../../components/workspace/AppWorkspaceContent.js";
export {
  appNameInterpolationVars,
  DEFAULT_BRANDING,
} from "../../config/branding-base.js";
export {
  BrandingContext,
  useBranding,
} from "../../config/branding-react.hooks.js";
export {
  AGENT_READY_EVENT,
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  CHAT_OPEN_EVENT,
  COMMAND_PALETTE_EVENT,
  dispatchAppEvent,
  dispatchBackIntent,
  dispatchChatOpen,
  dispatchChatPrefill,
  dispatchConnectRequest,
  dispatchFocusConnector,
  dispatchNavigateViewEvent,
  dispatchNavigateViewRequest,
  dispatchOpenNotificationCenter,
  FOCUS_CONNECTOR_EVENT,
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
} from "../../events/index.js";
export { isElizaCloudRuntimeLocked } from "../../first-run/mobile-runtime-mode.js";
export { BugReportProvider } from "../../hooks/BugReportProvider.js";
export {
  getCached,
  getRevalidationError,
  invalidate,
  revalidate,
  setCached,
  startPolling,
  subscribe,
} from "../../hooks/resource-cache.js";
export {
  isCapabilityWarmupAbort,
  loadAfterCapabilityWarmup,
  useAbortableCapabilityWarmup,
} from "../../hooks/runtime-capability-retry.js";
export {
  getActiveAgentAuthority,
  useActiveAgentAuthority,
} from "../../hooks/useActiveAgentAuthority.js";
export { useActivityEvents } from "../../hooks/useActivityEvents.js";
export { useAgentSessionRecovery } from "../../hooks/useAgentSessionRecovery.js";
export {
  getAuthStatusSnapshot,
  isAuthenticatedNow,
  subscribeAuthStatus,
  useAuthStatus,
} from "../../hooks/useAuthStatus.js";
export {
  useAvailableViews,
  useRoutableViews,
} from "../../hooks/useAvailableViews.js";
export { useBugReportState } from "../../hooks/useBugReport.hooks.js";
export { useContextMenu } from "../../hooks/useContextMenu.js";
export { useDesktopTabs } from "../../hooks/useDesktopTabs.js";
export { useSecretsManagerModalState } from "../../hooks/useSecretsManagerModal.js";
export { useSecretsManagerShortcut } from "../../hooks/useSecretsManagerShortcut.js";
export { createTranslator } from "../../i18n/index.js";
export {
  FramedPage,
  FramedPageBody,
} from "../../layouts/framed-page.js";
export { PageFrame } from "../../layouts/page-frame.js";
export { cn } from "../../lib/utils.js";
export { LoginAuthGuard } from "../../login/components/LoginAuthGuard.js";
export { LoginEmailCallback } from "../../login/components/LoginEmailCallback.js";
export {
  LoginForm,
  PASSKEY_ENROLL_PROMPT_KEY,
} from "../../login/components/LoginForm.js";
export { LoginLinkedAccounts } from "../../login/components/LoginLinkedAccounts.js";
export { LoginMfaChallenge } from "../../login/components/LoginMfaChallenge.js";
export { LoginMfaSettings } from "../../login/components/LoginMfaSettings.js";
export { LoginOAuthCallback } from "../../login/components/LoginOAuthCallback.js";
export { LoginTenantPicker } from "../../login/components/LoginTenantPicker.js";
export { LoginUserButton } from "../../login/components/LoginUserButton.js";
export { PasskeyEnrollmentPrompt } from "../../login/components/PasskeyEnrollmentPrompt.js";
export { useAuth } from "../../login/hooks/useAuth.js";
export { useMfaStepUp } from "../../login/hooks/useMfaStepUp.js";
export { DiscordIcon, GoogleIcon } from "../../login/icons/index.js";
export { LoginProvider, useLogin } from "../../login/provider.js";
export {
  createDefaultWagmiConfig,
  EVMWalletProvider,
  LoginConnectOrCreateWallet,
  LoginFormWithWallets,
  SolanaWalletProvider,
  WalletLogin,
} from "../../login/wallet/index.js";
export { pathForTab } from "../../navigation/index.js";
export { isElizaOS, isNative } from "../../platform/init.js";
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
} from "../../spatial/primitives.js";
export {
  publishAppValue,
  seedAppValue,
  useAppSelector,
  useAppSelectorShallow,
} from "../../state/app-store.js";
export { claimCloudLoginWindow } from "../../state/cloud-login-launch.js";
export { useTranslation } from "../../state/TranslationContext.hooks.js";
export { AppContext, useApp } from "../../state/useApp.js";
export { useWalletState } from "../../state/useWalletState.js";
export { useRegisterViewChatBinding } from "../../state/view-chat-binding.js";
export { resolveAppAssetUrl } from "../../utils/asset-url.js";
export { safeAttachmentUrl } from "../../utils/attachment-url.js";
export { copyTextToClipboard } from "../../utils/clipboard.js";
export { isCloudStatusReasonApiKeyOnly } from "../../utils/cloud-status.js";
export { confirmDesktopAction } from "../../utils/desktop-dialogs.js";
export {
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "../../utils/documents-upload-image.js";
export {
  canShareFiles,
  downloadAttachment,
  filenameForMime,
  shareAttachment,
} from "../../utils/download-share.js";
export { formatByteSize } from "../../utils/format.js";
export { openExternalUrl } from "../../utils/openExternalUrl.js";
export { registerBuiltinWidgets } from "../../widgets/registry.js";
export { WidgetHost } from "../../widgets/WidgetHost.js";
export { DiffReviewPanel } from "../composites/DiffReviewPanel.js";
export { DesktopTabBar } from "../DesktopTabBar.js";
