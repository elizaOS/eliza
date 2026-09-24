/**
 * Browser-safe entry point for renderer bundles.
 *
 * Keep this surface aligned with `src/index.ts`, but do not re-export modules
 * that require Node APIs or server-only runtime state.
 */

export { shouldUseCloudOnlyBranding } from "@elizaos/core/config/cloud-only";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "@elizaos/core/config/plugin-ui-spec";
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
  PatchOp,
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
} from "@elizaos/core/config/ui-spec";
export {
  RESTART_EXIT_CODE,
  type RestartHandler,
  requestRestart,
  setRestartHandler,
} from "@elizaos/core/restart";
export {
  parsePositiveFloat,
  parsePositiveInteger,
} from "@elizaos/core/utils/number-parsing";
// Keep the full app shell on the explicit `@elizaos/ui/App` entry. Exporting it
// from this broad browser facade creates a second bundled shell copy for plugin
// host imports, which can fold lazy route modules back into the entry chunk.
export * from "./agent-surface/index.ts";
export {
  type AgentElementHandle,
  useAgentElement,
} from "./agent-surface/useAgentElement.ts";
export * from "./api/android-native-agent-transport.ts";
export * from "./api/index.ts";
export * from "./api/response.ts";
export { sendJson, sendJsonError } from "./api/response.ts";
export { registerAppShellPage } from "./app-shell-registry.ts";
export {
  getAppDetailExtension,
  registerDetailExtension,
} from "./apps/detail-extension-registry.js";
export type {
  AppDetailExtensionComponent,
  AppDetailExtensionProps,
} from "./apps/detail-extension-types.js";
export type { OverlayApp, OverlayAppContext } from "./apps/overlay-app-api.js";
export {
  getAllOverlayApps,
  getAvailableOverlayApps,
  getOverlayApp,
  isAospAndroid,
  isOverlayApp,
  type OverlayAppAvailabilityContext,
  overlayAppToRegistryInfo,
  registerOverlayApp,
} from "./apps/overlay-app-registry.js";
export * from "./bridge/index.ts";
export * from "./cache-telemetry.ts";
export * from "./chat/index.ts";
export * from "./components/apps/AppWindowRenderer.helpers.ts";
export * from "./components/apps/AppWindowRenderer.tsx";
export * from "./components/apps/EmbeddedAppViewer.tsx";
export * from "./components/apps/extensions/surface.helpers.ts";
export * from "./components/apps/extensions/surface.tsx";
export { CharacterEditor } from "./components/character/CharacterEditor.tsx";
export * from "./components/character/character-greeting.ts";
export * from "./components/chat/widgets/shared.tsx";
export {
  EmptyWidgetState,
  WidgetSection,
} from "./components/chat/widgets/shared.tsx";
// The orchestrator/task-coordinator plugin imports this from `@elizaos/ui`
// (which the app build aliases to this browser entry). It is re-exported from
// the root index.ts too; keep both in sync. Missing here breaks
// `packages/app build:web` (plugin-agent-orchestrator/src/ui/register-slots.ts).
export { registerTaskWidget } from "./components/chat/widgets/task-widget.tsx";
export { DiffReviewPanel } from "./components/composites/code/DiffReviewPanel.tsx";
export { PagePanel } from "./components/composites/page-panel/index.ts";
export { SidebarContent } from "./components/composites/sidebar/sidebar-content.tsx";
export { SidebarPanel } from "./components/composites/sidebar/sidebar-panel.tsx";
export { Sidebar } from "./components/composites/sidebar/sidebar-root.tsx";
export { SidebarScrollRegion } from "./components/composites/sidebar/sidebar-scroll-region.tsx";
export * from "./components/config-ui/config-renderer.helpers.ts";
export * from "./components/config-ui/config-renderer.tsx";
export {
  evaluateUiVisibility,
  getSupportedComponents,
  runValidation as runUiValidation,
  sanitizeLinkHref,
} from "./components/config-ui/ui-renderer.helpers.ts";
export {
  type UiActionDispatchMetadata,
  UiRenderer,
  type UiRendererProps,
} from "./components/config-ui/ui-renderer.tsx";
export {
  getAllSettingsSections,
  getSettingsSection,
  listSettingsSections,
  registerSettingsSection,
  type SettingsSectionDef,
} from "./components/settings/settings-section-registry.ts";
export { AppPageSidebar } from "./components/shared/AppPageSidebar.tsx";
export * from "./components/shared/LanguageDropdown.helpers.ts";
export type { TranslatorFn } from "./components/shared/LanguageDropdown.tsx";
export * from "./components/shared/LanguageDropdown.tsx";
export * from "./components/shared/ThemeToggle.tsx";
export { LoadingScreen } from "./components/shell/LoadingScreen.tsx";
export * from "./components/ui/accordion.tsx";
export * from "./components/ui/alert.tsx";
export * from "./components/ui/alert-dialog.tsx";
export * from "./components/ui/avatar.tsx";
export { Badge } from "./components/ui/badge.tsx";
export { Button, type ButtonProps } from "./components/ui/button.tsx";
export * from "./components/ui/card.tsx";
export * from "./components/ui/checkbox.tsx";
export * from "./components/ui/code-block.tsx";
export * from "./components/ui/collapsible.tsx";
export { ConfirmDialog } from "./components/ui/confirm-dialog.tsx";
export * from "./components/ui/dialog.tsx";
export * from "./components/ui/dropdown-menu.tsx";
export { ErrorBoundary } from "./components/ui/error-boundary.tsx";
export * from "./components/ui/form.tsx";
export * from "./components/ui/grid.tsx";
export * from "./components/ui/hover-card.tsx";
export { Input } from "./components/ui/input.tsx";
export * from "./components/ui/label.tsx";
export * from "./components/ui/native-select.tsx";
export * from "./components/ui/popover.tsx";
export * from "./components/ui/progress.tsx";
export * from "./components/ui/radio-group.tsx";
export * from "./components/ui/scroll-area.tsx";
export { SegmentedControl } from "./components/ui/segmented-control.tsx";
export * from "./components/ui/select.tsx";
export * from "./components/ui/separator.tsx";
export { SettingsControls } from "./components/ui/settings-controls.tsx";
export { Skeleton } from "./components/ui/skeleton.tsx";
export * from "./components/ui/skeleton-layouts.tsx";
export { Spinner } from "./components/ui/spinner.tsx";
export {
  agentLifecycleLabel,
  statusLabelForState,
  statusToneForState,
} from "./components/ui/status-badge.helpers.ts";
export {
  StatusBadge,
  StatusDot,
  StatusPulseDot,
} from "./components/ui/status-badge.tsx";
export { Switch } from "./components/ui/switch.tsx";
export * from "./components/ui/table.tsx";
export * from "./components/ui/tabs.tsx";
export { TagEditor } from "./components/ui/tag-editor.tsx";
export * from "./components/ui/text-link.tsx";
export { Textarea } from "./components/ui/textarea.tsx";
export * from "./components/ui/toggle.tsx";
export * from "./components/ui/tooltip.tsx";
export { IconTooltip } from "./components/ui/tooltip-extended.tsx";
export * from "./components/workspace/AppWorkspaceChrome.tsx";
export * from "./components/workspace/AppWorkspaceContent.tsx";
// === Phase 5C: ./config/app-config moved to @elizaos/app/config/app-config ===
export * from "./config/boot-config.ts";
export * from "./config/boot-config-react.hooks.ts";
export * from "./config/branding.ts";
export * from "./config/config-catalog.ts";
export * from "./config/index.ts";
// === Phase 5C: ./desktop-runtime moved to @elizaos/app/runtime/desktop ===
export * from "./events/index.ts";
export {
  installFirstRunDeepLinkListener,
  routeFirstRunDeepLink,
} from "./first-run/deep-link-handler.ts";
export * from "./first-run/mobile-runtime-mode.ts";
export * from "./first-run/pre-seed-local-runtime.ts";
export * from "./first-run/reload-into-first-run-runtime.ts";
export * from "./first-run/runtime-target.ts";
export { BugReportProvider } from "./hooks/BugReportProvider.tsx";
export * from "./hooks/useActivityEvents.ts";
export * from "./hooks/useBugReport.hooks.ts";
export * from "./hooks/useChatAvatarVoiceBridge.ts";
export * from "./hooks/useContextMenu.ts";
export { useIntervalWhenDocumentVisible } from "./hooks/useDocumentVisibility.ts";
export { COMMON_SHORTCUTS } from "./hooks/useKeyboardShortcuts.ts";
export * from "./hooks/useMediaQuery.ts";
export * from "./hooks/useRenderGuard.ts";
export { useTimeout } from "./hooks/useTimeout.ts";
export * from "./hooks/useVoiceChat.ts";
export * from "./hooks/useWhatsAppPairing.ts";
export * from "./i18n/index.ts";
export * from "./index.ts";
export { ContentLayout } from "./layouts/content-layout/content-layout.tsx";
export { PageLayout } from "./layouts/page-layout/page-layout.tsx";
export { Z_GLOBAL_EMOTE, Z_SYSTEM_CRITICAL } from "./lib/floating-layers.ts";
export * from "./navigation/index.ts";
export * from "./platform/index.ts";
export * from "./slots/task-coordinator-slots.helpers.ts";
export * from "./slots/task-coordinator-slots.tsx";
export * from "./state/index.ts";
export * from "./themes/index.ts";
export * from "./types/index.ts";
export { resolveAppAssetUrl } from "./utils/asset-url.js";
export { copyTextToClipboard } from "./utils/clipboard.ts";
export { confirmDesktopAction } from "./utils/desktop-dialogs.ts";
export { loadDesktopWorkspaceSnapshot } from "./utils/desktop-workspace.ts";
export { modelLooksLikeElizaCloudHosted } from "./utils/eliza-cloud-model-route.js";
export * from "./utils/format.ts";
export {
  navigatePreOpenedWindow,
  openExternalUrl,
  preOpenWindow,
} from "./utils/openExternalUrl.ts";
export * from "./voice/index.ts";
export * from "./widgets/index.ts";
export { registerBuiltinWidgets } from "./widgets/registry-store.ts";
