/**
 * Thin browser entry for desktop shell widgets used by packages/app main.
 *
 * Do **not** re-export `@elizaos/ui/browser` here — that star-export pulls the
 * full agent UI graph (CharacterEditor, chat, core browser bundle) into the
 * anonymous `/login` critical path (#18056). The full browser facade remains
 * at `@elizaos/app-core` → `./browser.ts` for plugin hosts that need it.
 */

export {
  buildLocalizedTrayMenu,
  DESKTOP_TRAY_MENU_ITEMS,
  DesktopSurfaceNavigationRuntime,
  DesktopTrayRuntime,
  DetachedShellRoot,
} from "./runtime/desktop";
export { AppWindowRenderer } from "./runtime/desktop/AppWindowRenderer";
export {
  IOS_FULL_BUN_SMOKE_REQUEST_KEY,
  IOS_FULL_BUN_SMOKE_RESULT_KEY,
  runIosFullBunSmokeIfRequested,
} from "./platform/ios-runtime-bridge";
