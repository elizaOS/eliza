/**
 * Runtime view catalog behind the desktop tray "Views" submenu and the macOS
 * tray-popover launcher rows. DesktopTrayRuntime publishes the curated launcher
 * list here after the view registry loads; the TRAY_ACTION_EVENT handler
 * resolves a `tray-open-view-<id>` click against this catalog first and falls
 * back to the static DESKTOP_VIEW_WINDOWS mirror, so the five builtin views
 * keep working from the instant-boot menu even before (or without) a registry
 * read. Paths follow the launcher's navigation rule: an entry without a
 * declared path opens `/apps/<id>` (LauncherSurface's handleLaunch fallback),
 * and alias canonicalization already happened in curateLauncherPages.
 */
import { DESKTOP_VIEW_WINDOWS } from "./tray-menu";

export interface RuntimeTrayView {
  /** Canonical launcher/view id (post `canonicalLauncherId`). */
  readonly id: string;
  /** Display-ready label from the view entry (not localized here). */
  readonly label: string;
  /** Hash route the view window loads. */
  readonly path: string;
}

// Packaged-desktop e2e diagnostics seam (desktop-tray-views.e2e.spec.ts): the
// bridge `eval` has no ESM import path into the renderer bundle, so the latest
// published catalog is mirrored onto a well-known global — same pattern as
// `shell-surface-store` in @elizaos/ui. Read-only from the outside.
const TRAY_VIEWS_DIAGNOSTICS_KEY = Symbol.for("elizaos.desktop.tray-views");

let runtimeCatalog: readonly RuntimeTrayView[] = [];

/** Map a curated launcher entry to the runtime tray-view shape. */
export function launcherEntryToRuntimeTrayView(entry: {
  id: string;
  label: string;
  path?: string;
}): RuntimeTrayView {
  return {
    id: entry.id,
    label: entry.label,
    path: entry.path ?? `/apps/${entry.id}`,
  };
}

/** Replace the runtime catalog (called on every view-registry change). */
export function setRuntimeTrayViews(views: readonly RuntimeTrayView[]): void {
  runtimeCatalog = views;
  (globalThis as Record<PropertyKey, unknown>)[TRAY_VIEWS_DIAGNOSTICS_KEY] = {
    catalog: [...views],
  };
}

export function getRuntimeTrayViews(): readonly RuntimeTrayView[] {
  return runtimeCatalog;
}

/**
 * Resolve a tray view id to its window target: runtime catalog first (dynamic
 * launcher-derived entries), then the static DESKTOP_VIEW_WINDOWS mirror (the
 * instant-boot fallback), else `null` for an unknown id.
 */
export function resolveTrayViewWindow(viewId: string): RuntimeTrayView | null {
  const runtime = runtimeCatalog.find((view) => view.id === viewId);
  if (runtime) {
    return runtime;
  }
  const staticView = DESKTOP_VIEW_WINDOWS.find((view) => view.id === viewId);
  return staticView
    ? { id: staticView.id, label: staticView.label, path: staticView.path }
    : null;
}
