// Compatibility exports for app packages that still import app UI helpers from
// @elizaos/app-core. The implementations live in @elizaos/ui.

export type {
  AppDetailExtensionComponent,
  AppDetailExtensionProps,
  AppOperatorSurfaceComponent,
  AppOperatorSurfaceFocus,
  AppOperatorSurfaceProps,
  AppOperatorSurfaceVariant,
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
  AppSessionJsonValue,
  SelectedAppRun,
  SurfaceTone,
} from "@elizaos/ui";
export {
  client,
  ElizaClient,
  formatDetailTimestamp,
  getAppDetailExtension,
  getAppOperatorSurface,
  registerDetailExtension,
  registerOperatorSurface,
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/ui";
