/**
 * Browser-safe surface of `@elizaos/app`, aliased in by browser bundlers in
 * place of the Node `index.ts`. Re-exports the dashboard React/UI components,
 * registration contracts, and Electrobun desktop runtimes from `@elizaos/ui` and
 * `@elizaos/core`, and provides explicit failures for the server-only helpers
 * (`sendJson`, `ensureRouteAuthorized`, `sharedVault`, …) so browser code links
 * against the same names without pulling in Node server modules.
 */
// Registration-surface contracts live in @elizaos/core (React-free canonical
// home); import them from there rather than the React package.

export { resolveAppBranding } from "@elizaos/core/config/app-config";
export type {
  AppRunSummary,
  AppSessionJsonValue,
} from "@elizaos/core/contracts/apps";
export * from "@elizaos/ui";
export {
  type AppDetailExtensionProps,
  Button,
  client,
  ErrorBoundary,
  formatDetailTimestamp,
  Input,
  type IosRuntimeConfig,
  type OverlayApp,
  type OverlayAppContext,
  PagePanel,
  registerDetailExtension,
  registerOverlayApp,
  resolveIosRuntimeConfig,
  Spinner,
  StatusBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  type SurfaceTone,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
  useApp,
} from "@elizaos/ui";
export {
  type AutomationNodeContributorContext,
  registerAutomationNodeContributor,
} from "./api/automation-node-contributors";
export { IOS_FULL_BUN_SMOKE_FAILURE_RE } from "./platform/chat-failure-strings";
export {
  IOS_FULL_BUN_SMOKE_REQUEST_KEY,
  IOS_FULL_BUN_SMOKE_RESULT_KEY,
  runIosFullBunSmokeIfRequested,
} from "./platform/ios-runtime-bridge";
export {
  buildLocalizedTrayMenu,
  DESKTOP_TRAY_MENU_ITEMS,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
} from "./runtime/desktop";
export { getHostExecutionCapabilities } from "./services/task-host-capabilities";

import { ElizaError } from "@elizaos/core/errors";

function unsupportedServerOperation(): never {
  throw new ElizaError(
    "Server-only operation is unavailable in the browser renderer",
    {
      code: "BROWSER_SERVER_OPERATION_UNAVAILABLE",
    },
  );
}

export type CompatRuntimeState = {
  current: unknown;
  pendingAgentName?: string | null;
  pendingRestartReasons?: string[];
};
export function sendJson(
  _res: unknown,
  _status: number,
  _body: unknown,
): never {
  return unsupportedServerOperation();
}

export function sendJsonError(
  _res: unknown,
  _status: number,
  _message: string,
): never {
  return unsupportedServerOperation();
}

export async function ensureRouteAuthorized(): Promise<boolean> {
  return false;
}
export async function ensureCompatApiAuthorized(): Promise<boolean> {
  return false;
}
export async function readCompatJsonBody(): Promise<unknown> {
  return unsupportedServerOperation();
}
export function sharedVault(): never {
  return unsupportedServerOperation();
}
