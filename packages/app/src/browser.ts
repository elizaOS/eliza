/** Browser-only app composition. Shared UI and contracts are imported from their owners. */
export { IOS_FULL_BUN_SMOKE_FAILURE_RE } from "./platform/chat-failure-strings";
export {
  IOS_FULL_BUN_SMOKE_REQUEST_KEY,
  IOS_FULL_BUN_SMOKE_RESULT_KEY,
  runIosFullBunSmokeIfRequested,
} from "./platform/ios-runtime-bridge";
export type { DetachedShellRootProps } from "./runtime/desktop";
export {
  buildLocalizedTrayMenu,
  DESKTOP_TRAY_MENU_ITEMS,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
} from "./runtime/desktop";
