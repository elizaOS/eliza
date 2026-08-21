/**
 * Static catalog + label localization for the desktop (Electrobun) system-tray
 * menu. Declares the deliberately small native tray tree
 * (DESKTOP_TRAY_MENU_ITEMS), the desktop-eligible builtin views used by the
 * separate tray launcher popover (DESKTOP_VIEW_WINDOWS), the
 * `tray-open-view-<id>` item-id codec, and the
 * click-audit table (DESKTOP_TRAY_CLICK_AUDIT) that pins each tray id to its
 * expected renderer action. `buildLocalizedTrayMenu()` resolves labelKeys
 * through a translator at desktop boot. Everything here is pure so the tray
 * shape stays unit-testable and out of the `@elizaos/agent` view-catalog import
 * graph — the renderer bundle builds the tray synchronously, with no /api/views
 * round-trip. DesktopTrayRuntime consumes these to build and dispatch the native
 * tray.
 */
import type { DesktopClickAuditItem } from "@elizaos/ui/utils/desktop-workspace";

interface DesktopTrayMenuItem {
  id: string;
  label?: string;
  /** i18n key for {@link label}; resolved at menu-build time. */
  labelKey?: string;
  type?: "normal" | "separator";
  /** Nested items — rendered as a native tray submenu. */
  submenu?: DesktopTrayMenuItem[];
}

/**
 * Curated desktop-eligible view windows for the tray launcher popover (#10716).
 *
 * Mirror of the `desktopTabEnabled: true` entries in
 * `packages/agent/src/api/builtin-views.ts` (`BUILTIN_VIEWS`) that also run on
 * desktop (i.e. `camera` is android-only and excluded). Duplicated here — the
 * same reason `application-menu.ts` duplicates `APP_MENU_ENTRIES`: this module
 * is consumed by the renderer/browser bundle and the tray is built
 * synchronously at desktop boot, so it must not pull `@elizaos/agent` (the view
 * catalog owner) into the browser graph or wait on a `/api/views` round-trip.
 * `desktop-view-windows.test.ts` (standard app-core lane, which can import the
 * agent catalog) asserts this list stays in sync with `BUILTIN_VIEWS`.
 */
export interface DesktopViewWindow {
  /** Stable builtin view id (matches the entry in `builtin-views.ts`). */
  readonly id: string;
  readonly label: string;
  /** i18n key for {@link label}; resolved at menu-build time. */
  readonly labelKey: string;
  /** Hash route the view window loads (matches `ViewDeclaration.path`). */
  readonly path: string;
}

export const DESKTOP_VIEW_WINDOWS: readonly DesktopViewWindow[] = [
  {
    id: "chat",
    label: "Messages",
    labelKey: "desktop.views.chat",
    path: "/chat",
  },
  {
    id: "browser",
    label: "Browser",
    labelKey: "desktop.views.browser",
    path: "/browser",
  },
  {
    id: "character",
    label: "Character",
    labelKey: "desktop.views.character",
    path: "/character",
  },
  {
    id: "documents",
    label: "Knowledge",
    labelKey: "desktop.views.documents",
    path: "/character/documents",
  },
  {
    id: "settings",
    label: "Settings",
    labelKey: "desktop.views.settings",
    path: "/settings",
  },
  {
    id: "background",
    label: "Background",
    labelKey: "desktop.views.background",
    path: "/background",
  },
] as const;

/** Prefix for tray item ids that open a view in its own desktop window. */
export const TRAY_OPEN_VIEW_PREFIX = "tray-open-view-";

/** Tray item id that opens `viewId` in its own desktop window. */
export function trayOpenViewItemId(viewId: string): string {
  return `${TRAY_OPEN_VIEW_PREFIX}${viewId}`;
}

/**
 * Parse a `tray-open-view-<id>` item id back to its view id, or `null` when the
 * id is not a view-window item. The renderer handler resolves the id against
 * {@link DESKTOP_VIEW_WINDOWS} before opening a window.
 */
export function parseTrayOpenViewItemId(itemId: string): string | null {
  return itemId.startsWith(TRAY_OPEN_VIEW_PREFIX)
    ? itemId.slice(TRAY_OPEN_VIEW_PREFIX.length)
    : null;
}

/**
 * Build tray launcher items from {@link DESKTOP_VIEW_WINDOWS}. Each item id is
 * `tray-open-view-<viewId>`; the renderer opens the matching view in its own
 * desktop window. Pure so the launcher shape is unit-testable.
 */
export function buildTrayViewItems(): DesktopTrayMenuItem[] {
  return DESKTOP_VIEW_WINDOWS.map((view) => ({
    id: trayOpenViewItemId(view.id),
    label: view.label,
    labelKey: view.labelKey,
  }));
}

export const DESKTOP_TRAY_MENU_ITEMS: readonly DesktopTrayMenuItem[] = [
  {
    id: "tray-show-window",
    label: "Open Eliza",
    labelKey: "desktop.tray.openEliza",
  },
  {
    id: "tray-open-desktop-workspace",
    label: "Open Workspace",
  },
  {
    id: "tray-open-settings",
    label: "Settings…",
  },
  { id: "tray-sep-0", type: "separator" },
  { id: "quit", label: "Quit Eliza" },
] as const;

/**
 * Build the tray menu with labels translated by `t`. Separators and any item
 * without a `labelKey` pass through unchanged. The native tray is rebuilt from
 * this at desktop boot, so it reflects the resolved UI language.
 */
export function buildLocalizedTrayMenu(
  t: (key: string, vars?: { defaultValue?: string }) => string,
): DesktopTrayMenuItem[] {
  const localize = (item: DesktopTrayMenuItem): DesktopTrayMenuItem => {
    const localized: DesktopTrayMenuItem = item.labelKey
      ? { ...item, label: t(item.labelKey, { defaultValue: item.label }) }
      : { ...item };
    if (item.submenu) {
      localized.submenu = item.submenu.map(localize);
    }
    return localized;
  };
  return DESKTOP_TRAY_MENU_ITEMS.map(localize);
}

export const DESKTOP_TRAY_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "tray-show-window",
    entryPoint: "tray",
    label: "Open Eliza",
    expectedAction: "Show and focus the main Eliza surface.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-desktop-workspace",
    entryPoint: "tray",
    label: "Open Workspace",
    expectedAction:
      "Open and focus the singleton Eliza Workspace without duplicating the detached assistant.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-settings",
    entryPoint: "tray",
    label: "Settings…",
    expectedAction: "Open Settings inside the full Eliza workspace.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "quit",
    entryPoint: "tray",
    label: "Quit Eliza",
    expectedAction: "Quit the desktop application.",
    runtimeRequirement: "desktop",
    coverage: "manual",
  },
] as const;
