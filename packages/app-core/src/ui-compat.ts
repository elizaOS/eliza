// Compatibility exports for app packages that still import app UI helpers from
// @elizaos/app-core. The implementations live in @elizaos/ui.

export { client, ElizaClient } from "@elizaos/ui/api/client";
export type {
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
  AppSessionJsonValue,
} from "@elizaos/ui/api/client-types";
export {
  getAppDetailExtension,
  registerDetailExtension,
} from "@elizaos/ui/components/apps/extensions/registry";
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
} from "@elizaos/ui/components/apps/extensions/surface";
export type {
  SelectedAppRun,
  SurfaceTone,
} from "@elizaos/ui/components/apps/extensions/surface";
export type {
  AppDetailExtensionComponent,
  AppDetailExtensionProps,
} from "@elizaos/ui/components/apps/extensions/types";
export {
  getAppOperatorSurface,
  registerOperatorSurface,
} from "@elizaos/ui/components/apps/surfaces/registry";
export type {
  AppOperatorSurfaceComponent,
  AppOperatorSurfaceFocus,
  AppOperatorSurfaceProps,
  AppOperatorSurfaceVariant,
} from "@elizaos/ui/components/apps/surfaces/types";
export { useApp } from "@elizaos/ui";
