export { resolveAppBranding } from "@elizaos/shared";
export {
  type AppRunSummary,
  type AppSessionJsonValue,
  client,
  type FeedActivityItem,
  type FeedAgentStatus,
  type FeedChatMessage,
  type FeedTeamAgent,
} from "@elizaos/ui/api";
export * from "@elizaos/ui/browser";
export { ErrorBoundary } from "@elizaos/ui/browser";
export { registerDetailExtension } from "@elizaos/ui/components/apps/extensions/registry";
export {
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  type SurfaceTone,
} from "@elizaos/ui/components/apps/extensions/surface";
export {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "@elizaos/ui/components/apps/extensions/surface.helpers";
export type { AppDetailExtensionProps } from "@elizaos/ui/components/apps/extensions/types";
export type {
  OverlayApp,
  OverlayAppContext,
} from "@elizaos/ui/components/apps/overlay-app-api";
export { registerOverlayApp } from "@elizaos/ui/components/apps/overlay-app-registry";
export {
  type GameOperatorAction,
  type GameOperatorEvent,
  GameOperatorShell,
} from "@elizaos/ui/components/apps/surfaces/GameOperatorShell";
export { registerOperatorSurface } from "@elizaos/ui/components/apps/surfaces/registry";
export type { AppOperatorSurfaceProps } from "@elizaos/ui/components/apps/surfaces/types";
export { PagePanel } from "@elizaos/ui/components/composites/page-panel";
export { Button } from "@elizaos/ui/components/ui/button";
export { Input } from "@elizaos/ui/components/ui/input";
export { Spinner } from "@elizaos/ui/components/ui/spinner";
export {
  type IosRuntimeConfig,
  resolveIosRuntimeConfig,
} from "@elizaos/ui/platform/ios-runtime";
export { useApp } from "@elizaos/ui/state/useApp";
export {
  type AutomationNodeContributorContext,
  registerAutomationNodeContributor,
} from "./api/automation-node-contributors";
export {
  buildLocalizedTrayMenu,
  DESKTOP_TRAY_MENU_ITEMS,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
} from "./runtime/desktop";
export { AppWindowRenderer } from "./runtime/desktop/AppWindowRenderer";
export { getHostExecutionCapabilities } from "./services/task-host-capabilities";

export type CompatRuntimeState = {
  current: unknown;
  pendingAgentName?: string | null;
  pendingRestartReasons?: string[];
};

export function sendJson(
  _res: unknown,
  _status: number,
  _body: unknown,
): void {}

export function sendJsonError(
  _res: unknown,
  _status: number,
  _message: string,
): void {}

export async function ensureRouteAuthorized(): Promise<boolean> {
  return false;
}

export async function ensureCompatApiAuthorized(): Promise<boolean> {
  return false;
}

export async function readCompatJsonBody(): Promise<unknown> {
  return null;
}

export function sharedVault(): never {
  throw new Error("sharedVault is server-only");
}
