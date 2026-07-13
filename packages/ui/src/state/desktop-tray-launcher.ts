/**
 * Runtime registry for the desktop tray-popover launcher rows: the desktop host
 * contributes resolved, localized rows and the presentational TrayLauncher reads
 * them. See the block below for why @elizaos/ui cannot import the catalog directly.
 */
import { useSyncExternalStore } from "react";

/**
 * Runtime registry for the desktop tray-popover launcher rows (#12184).
 *
 * The launcher catalog's single source of truth is `DESKTOP_VIEW_WINDOWS` in
 * `@elizaos/app-core` (`runtime/desktop/tray-menu.ts`). `@elizaos/ui` cannot
 * import `@elizaos/app-core` (that package depends on this one — importing it
 * back would be a cycle), so the desktop host registers the resolved,
 * localized rows here at runtime and the presentational `TrayLauncher`
 * (rendered inside `TrayPopoverShell`) reads them. Same pattern as
 * `registerAppShellPage`: the host contributes, the shell renders.
 */

/** Semantic icon key — the presentational layer maps it to a concrete glyph. */
export type DesktopLauncherIconId =
  | "chat"
  | "character"
  | "documents"
  | "settings"
  | "background"
  | "home"
  | "view";

export interface DesktopLauncherEntry {
  /**
   * Tray item id dispatched on click (e.g. `tray-open-view-chat`,
   * `tray-show-window`) — routed through the same `TRAY_ACTION_EVENT` handling
   * the native tray menu uses (`DesktopTrayRuntime`).
   */
  readonly itemId: string;
  /** Localized row label. */
  readonly label: string;
  /** Semantic icon key resolved to a glyph by the presentational layer. */
  readonly icon: DesktopLauncherIconId;
}

let entries: readonly DesktopLauncherEntry[] = [];
const listeners = new Set<() => void>();

// Packaged-desktop e2e diagnostics seam (desktop-tray-views.e2e.spec.ts): the
// bridge `eval` has no ESM import path into the renderer bundle, so the current
// rows are mirrored onto a well-known global — same pattern as
// `shell-surface-store`. Read-only from the outside; app code uses the store.
const LAUNCHER_ROWS_DIAGNOSTICS_KEY = Symbol.for(
  "elizaos.ui.desktop-tray-launcher",
);

/** Replace the desktop launcher rows and notify subscribers. */
export function setDesktopLauncherEntries(
  next: readonly DesktopLauncherEntry[],
): void {
  entries = next;
  (globalThis as Record<PropertyKey, unknown>)[LAUNCHER_ROWS_DIAGNOSTICS_KEY] =
    { entries: [...next] };
  for (const listener of listeners) {
    listener();
  }
}

export function getDesktopLauncherEntries(): readonly DesktopLauncherEntry[] {
  return entries;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a React component to the desktop launcher rows. */
export function useDesktopLauncherEntries(): readonly DesktopLauncherEntry[] {
  return useSyncExternalStore(
    subscribe,
    getDesktopLauncherEntries,
    getDesktopLauncherEntries,
  );
}
