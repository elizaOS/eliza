import { getBrandConfig } from "./brand-config";
import type { ManagedWindowSnapshot } from "./surface-windows";

// Minimal slug + display + windowPath slice mirroring the renderer-side
// internal-tool ViewDeclarations in `packages/ui/src/components/apps/
// internal-tool-apps.ts` (the source of truth — it owns hero images,
// capabilities, ordering). Duplicated here to avoid pulling renderer modules
// into the bun bundle; keep in sync until the bun bundler exposes safe access
// to the renderer module graph.
export interface AppMenuEntry {
  readonly slug: string;
  readonly name: string;
  readonly displayName: string;
  readonly windowPath: string;
  /**
   * When true, the renderer routes the menu/tray click to the App Details
   * page (`/apps/<slug>/details`) instead of opening the app window
   * directly. Mirror of the declaration's `hasDetailsPage`.
   */
  readonly hasDetailsPage: boolean;
}

const APP_MENU_ENTRIES: readonly AppMenuEntry[] = [
  {
    slug: "plugin-viewer",
    name: "@elizaos/app-plugin-viewer",
    displayName: "Plugin Viewer",
    windowPath: "/apps/plugins",
    hasDetailsPage: false,
  },
  {
    slug: "skills-viewer",
    name: "@elizaos/app-skills-viewer",
    displayName: "Skills Viewer",
    windowPath: "/apps/skills",
    hasDetailsPage: false,
  },
  {
    slug: "training",
    name: "@elizaos/plugin-training",
    displayName: "Fine Tuning",
    windowPath: "/apps/fine-tuning",
    hasDetailsPage: true,
  },
  {
    slug: "trajectory-viewer",
    name: "@elizaos/app-trajectory-viewer",
    displayName: "Trajectory Viewer",
    windowPath: "/apps/trajectories",
    hasDetailsPage: false,
  },
  {
    slug: "relationship-viewer",
    name: "@elizaos/app-relationship-viewer",
    displayName: "Relationship Viewer",
    windowPath: "/apps/relationships",
    hasDetailsPage: false,
  },
  {
    slug: "memory-viewer",
    name: "@elizaos/app-memory-viewer",
    displayName: "Memory Viewer",
    windowPath: "/apps/memories",
    hasDetailsPage: false,
  },
  {
    slug: "runtime-debugger",
    name: "@elizaos/app-runtime-debugger",
    displayName: "Runtime Debugger",
    windowPath: "/apps/runtime",
    hasDetailsPage: false,
  },
  {
    slug: "database-viewer",
    name: "@elizaos/app-database-viewer",
    displayName: "Database Viewer",
    windowPath: "/apps/database",
    hasDetailsPage: false,
  },
  {
    slug: "log-viewer",
    name: "@elizaos/app-log-viewer",
    displayName: "Log Viewer",
    windowPath: "/apps/logs",
    hasDetailsPage: false,
  },
] as const;

export function getAppMenuEntries(): readonly AppMenuEntry[] {
  return APP_MENU_ENTRIES;
}

export function findAppMenuEntryBySlug(slug: string): AppMenuEntry | undefined {
  return APP_MENU_ENTRIES.find((entry) => entry.slug === slug);
}

// Curated desktop-eligible view windows for the menu-bar "Views" submenu
// (#10716). Mirror of the `desktopTabEnabled: true` entries in
// `packages/agent/src/api/builtin-views.ts` that also run on desktop (`camera`
// is android-only and excluded). Duplicated here for the same reason as
// APP_MENU_ENTRIES above — this bun-side module must not pull `@elizaos/agent`
// (the catalog owner) into the main-process bundle. `application-menu.test.ts`
// asserts this list stays in sync with the renderer-side DESKTOP_VIEW_WINDOWS.
export interface ViewMenuEntry {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

const VIEW_MENU_ENTRIES: readonly ViewMenuEntry[] = [
  { id: "tutorial", label: "Tutorial", path: "/tutorial" },
  { id: "help", label: "Help", path: "/help" },
  { id: "chat", label: "Messages", path: "/chat" },
  { id: "character", label: "Character", path: "/character" },
  { id: "documents", label: "Knowledge", path: "/character/documents" },
  { id: "settings", label: "Settings", path: "/settings" },
  { id: "background", label: "Background", path: "/background" },
] as const;

export function getViewMenuEntries(): readonly ViewMenuEntry[] {
  return VIEW_MENU_ENTRIES;
}

/** Menu-bar action prefix for opening a view in its own desktop window. */
export const NEW_VIEW_WINDOW_ACTION_PREFIX = "new-window:view-";

/**
 * Parse a `new-window:view-<id>` menu action to its view id, or `undefined`
 * when the action is not a view-window action. `index.ts` resolves the id
 * against {@link getViewMenuEntries} to open the window.
 */
export function parseViewWindowAction(
  action: string | undefined,
): string | undefined {
  if (!action?.startsWith(NEW_VIEW_WINDOW_ACTION_PREFIX)) {
    return undefined;
  }
  const id = action.slice(NEW_VIEW_WINDOW_ACTION_PREFIX.length).trim();
  return id || undefined;
}

export function findViewMenuEntryById(id: string): ViewMenuEntry | undefined {
  return VIEW_MENU_ENTRIES.find((entry) => entry.id === id);
}

/**
 * Menu-bar "Views" submenu — opens each desktop-eligible builtin view in its
 * own window. Pure builder so the shape is diffable in tests.
 */
export function buildViewsMenu(): ApplicationMenuItem {
  return {
    label: "Views",
    submenu: VIEW_MENU_ENTRIES.map((entry) => ({
      label: entry.label,
      action: `${NEW_VIEW_WINDOW_ACTION_PREFIX}${entry.id}`,
    })),
  };
}

/**
 * OS menu bar structure for Electrobun. Each **`action`** is emitted as
 * `application-menu-clicked` and handled in `index.ts`. **Why a pure builder:**
 * tests and reviewers can diff menu shape without reading IPC wiring.
 *
 * **`reset-app`** is handled in `index.ts` (`resetthe appFromApplicationMenu`):
 * native confirm + `POST /api/agent/reset` + embedded or HTTP restart, then
 * `desktopTrayMenuClick` with `menu-reset-app-applied` so the renderer runs
 * **`handleResetAppliedFromMain`** (same local UI sync as Settings **`handleReset`**).
 */

type ApplicationMenuRole =
  | "about"
  | "services"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "reload"
  | "forceReload"
  | "toggleDevTools"
  | "resetZoom"
  | "zoomIn"
  | "zoomOut"
  | "toggleFullScreen"
  | "minimize"
  | "close"
  | "zoom"
  | "bringAllToFront"
  | "cycleThroughWindows";

export type ApplicationMenuItem = {
  label?: string;
  submenu?: ApplicationMenuItem[];
  role?: ApplicationMenuRole;
  action?: string;
  accelerator?: string;
  type?: "separator";
  enabled?: boolean;
};

const SETTINGS_ACTION_PREFIX = "open-settings-";

function buildOpenWindowItems(
  windows: ManagedWindowSnapshot[],
  emptyLabel: string,
): ApplicationMenuItem[] {
  if (windows.length === 0) {
    return [{ label: emptyLabel, enabled: false }];
  }

  return windows.map((window) => ({
    label: window.title,
    action: `focus-window:${window.id}`,
  }));
}

export function parseSettingsWindowAction(
  action: string | undefined,
): string | undefined {
  if (action === "open-settings") {
    return undefined;
  }

  if (!action?.startsWith(SETTINGS_ACTION_PREFIX)) {
    return undefined;
  }

  const tabHint = action.slice(SETTINGS_ACTION_PREFIX.length).trim();
  return tabHint || undefined;
}

function buildAppsMenu(): ApplicationMenuItem {
  return {
    label: "Apps",
    submenu: APP_MENU_ENTRIES.map((entry) => ({
      label: entry.displayName,
      action: `apps:${entry.slug}`,
    })),
  };
}

function buildDesktopMenu(isMac: boolean): ApplicationMenuItem {
  const appName = getBrandConfig().appName;
  return {
    label: "Desktop",
    submenu: [
      { label: "Desktop Workspace", action: "open-settings-desktop" },
      { label: "Voice Controls", action: "open-settings-voice" },
      { label: "Permissions", action: "open-settings-permissions" },
      { label: "Cloud Settings", action: "open-settings-cloud" },
      { label: "Settings Window", action: "open-settings" },
      {
        label: "Secrets Storage…",
        action: "open-secrets-manager",
        // Same accelerator the renderer-side keydown listener watches
        // for. ⌘⌥⌃V on Mac, Ctrl+Alt+Shift+V elsewhere — distinctive
        // enough to avoid conflicts with the OS or other apps.
        accelerator: isMac ? "Command+Option+Control+V" : "Ctrl+Alt+Shift+V",
      },
      { type: "separator" },
      { label: `Show ${appName}`, action: "show" },
      { label: `Focus ${appName}`, action: "focus-main-window" },
      { label: `Hide ${appName}`, action: "hide-main-window" },
      { label: `Maximize ${appName}`, action: "maximize-main-window" },
      { label: `Restore ${appName} Size`, action: "restore-main-window" },
      { type: "separator" },
      // The visible native way into the notification center on desktop, where
      // the floating bell is hidden and the home pull-down is the only other
      // entry point (#10706). Routed to the renderer as `open-notifications`.
      { label: "Notifications", action: "open-notifications" },
      { label: "Send Test Notification", action: "desktop-notify" },
      { label: "Restart Agent", action: "restart-agent" },
      { label: `Relaunch ${appName}`, action: "relaunch" },
    ],
  };
}

function buildQuitMenuItem(
  isMac: boolean,
  appName: string,
): ApplicationMenuItem {
  if (isMac) {
    return {
      label: `Quit ${appName}`,
      role: "quit",
      accelerator: "Command+Q",
    };
  }

  return {
    label: `Quit ${appName}`,
    action: "quit",
    accelerator: "Ctrl+Q",
  };
}

function buildCloseWindowMenuItem(isMac: boolean): ApplicationMenuItem {
  return {
    label: "Close Window",
    role: "close",
    accelerator: isMac ? "Command+W" : "Ctrl+F4",
  };
}

export function buildApplicationMenu({
  isMac,
  browserEnabled,
  detachedWindows,
  agentReady = true,
}: {
  isMac: boolean;
  browserEnabled: boolean;
  detachedWindows: ManagedWindowSnapshot[];
  agentReady?: boolean;
}): ApplicationMenuItem[] {
  const appName = getBrandConfig().appName;
  const visibleDetachedWindows = browserEnabled
    ? detachedWindows
    : detachedWindows.filter((window) => window.surface !== "browser");

  return [
    {
      label: appName,
      submenu: [
        ...(isMac
          ? ([{ role: "about" }] as ApplicationMenuItem[])
          : ([
              { label: `About ${appName}`, action: "open-about" },
            ] as ApplicationMenuItem[])),
        { label: "Check for Updates", action: "check-for-updates" },
        { type: "separator" },
        {
          label: "Settings...",
          action: "open-settings",
          accelerator: isMac ? "Command+," : "Ctrl+,",
        },
        { label: "Restart Agent", action: "restart-agent" },
        { label: `Relaunch ${appName}`, action: "relaunch" },
        { label: `Reset ${appName}...`, action: "reset-app" },
        { type: "separator" },
        ...(isMac
          ? [
              { role: "services" },
              { type: "separator" as const },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "showAll" },
              { type: "separator" as const },
            ]
          : []),
        buildQuitMenuItem(isMac, appName),
      ] as ApplicationMenuItem[],
    },
    {
      label: "File",
      submenu: [
        { label: "Import Config...", action: "import-config" },
        { label: "Export Config...", action: "export-config" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo", accelerator: isMac ? "Command+Z" : "Ctrl+Z" },
        {
          role: "redo",
          accelerator: isMac ? "Shift+Command+Z" : "Ctrl+Y",
        },
        { type: "separator" },
        { role: "cut", accelerator: isMac ? "Command+X" : "Ctrl+X" },
        { role: "copy", accelerator: isMac ? "Command+C" : "Ctrl+C" },
        { role: "paste", accelerator: isMac ? "Command+V" : "Ctrl+V" },
        {
          role: "selectAll",
          accelerator: isMac ? "Command+A" : "Ctrl+A",
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", role: "reload" },
        { label: "Force Reload", role: "forceReload" },
        {
          label: "Toggle Developer Tools",
          action: "toggle-devtools",
          accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I",
        },
        { type: "separator" },
        { label: "Actual Size", role: "resetZoom" },
        { label: "Zoom In", role: "zoomIn" },
        { label: "Zoom Out", role: "zoomOut" },
        { type: "separator" },
        { label: "Toggle Full Screen", role: "toggleFullScreen" },
      ],
    },
    buildDesktopMenu(isMac),
    buildAppsMenu(),
    buildViewsMenu(),
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        buildCloseWindowMenuItem(isMac),
        ...(isMac
          ? [
              { role: "zoom" },
              {
                role: "cycleThroughWindows",
                accelerator: "Control+F4",
              },
              { type: "separator" as const },
              { role: "bringAllToFront" },
            ]
          : []),
        { type: "separator" },
        { label: `Show ${appName}`, action: "show" },
        { label: `Focus ${appName}`, action: "focus-main-window" },
        { label: `Hide ${appName}`, action: "hide-main-window" },
        { label: `Maximize ${appName}`, action: "maximize-main-window" },
        {
          label: `Restore ${appName} Size`,
          action: "restore-main-window",
        },
        ...(agentReady
          ? [
              { type: "separator" as const },
              ...(browserEnabled
                ? [
                    {
                      label: "New Browser Window",
                      action: "new-window:browser",
                    } satisfies ApplicationMenuItem,
                  ]
                : []),
              { label: "New Chat Window", action: "new-window:chat" },
              {
                label: "New Heartbeats Window",
                action: "new-window:triggers",
              },
              { label: "New Plugins Window", action: "new-window:plugins" },
              {
                label: "New Connectors Window",
                action: "new-window:connectors",
              },
              { label: "New Cloud Window", action: "new-window:cloud" },
              { label: "Settings Window", action: "open-settings" },
              { type: "separator" as const },
              ...buildOpenWindowItems(
                visibleDetachedWindows,
                "No open detached windows",
              ),
            ]
          : []),
      ] as ApplicationMenuItem[],
    },
  ];
}
