// Compatibility exports for app packages that still import app UI helpers from
// @elizaos/app-core. The implementations live in @elizaos/ui.

export { client, ElizaClient } from "@elizaos/ui";
export type {
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
  AppSessionJsonValue,
} from "@elizaos/ui";
export {
  getAppDetailExtension,
  registerDetailExtension,
} from "@elizaos/ui";
export {
  formatDetailTimestamp,
  selectLatestRunForApp,
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "@elizaos/ui";
export type {
  SelectedAppRun,
  SurfaceTone,
} from "@elizaos/ui";
export type {
  AppDetailExtensionComponent,
  AppDetailExtensionProps,
} from "@elizaos/ui";
export {
  getAppOperatorSurface,
  registerOperatorSurface,
} from "@elizaos/ui";
export type {
  AppOperatorSurfaceComponent,
  AppOperatorSurfaceFocus,
  AppOperatorSurfaceProps,
  AppOperatorSurfaceVariant,
} from "@elizaos/ui";
export { useApp } from "@elizaos/ui";
