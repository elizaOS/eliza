import { getBrandConfig } from "./brand-config";
import type { ManagedWindowSnapshot } from "./surface-windows";

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

export interface HeartbeatMenuSnapshot {
  loading: boolean;
  error: string | null;
  totalHeartbeats: number;
  activeHeartbeats: number;
  totalExecutions: number;
  totalFailures: number;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
}

export const EMPTY_HEARTBEAT_MENU_SNAPSHOT: HeartbeatMenuSnapshot = {
  loading: true,
  error: null,
  totalHeartbeats: 0,
  activeHeartbeats: 0,
  totalExecutions: 0,
  totalFailures: 0,
  lastRunAtMs: null,
  nextRunAtMs: null,
};

const SETTINGS_ACTION_PREFIX = "open-settings-";

function formatHeartbeatTimestamp(
  value: number | null,
  fallback: string,
): string {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return fallback;
  }
  return new Date(value).toLocaleString();
}

function buildHeartbeatStatusLabel(snapshot: HeartbeatMenuSnapshot): string {
  if (snapshot.loading) return "Status: Loading...";
  if (snapshot.error) return `Status: ${snapshot.error}`;
  return "Status: Monitoring";
}

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

function buildSurfaceMenu(
  label: string,
  surface: Extract<
    ManagedWindowSnapshot["surface"],
    "chat" | "plugins" | "connectors" | "triggers"
  >,
  windows: ManagedWindowSnapshot[],
  heartbeatSnapshot?: HeartbeatMenuSnapshot,
): ApplicationMenuItem {
  const baseItems: ApplicationMenuItem[] = [
    { label: "Show in Main Window", action: `show-main:${surface}` },
    { label: `Open New ${label} Window`, action: `new-window:${surface}` },
  ];

  if (surface === "triggers" && heartbeatSnapshot) {
    baseItems.push(
      { label: "Refresh Heartbeats", action: "refresh-heartbeats" },
      { type: "separator" },
      { label: buildHeartbeatStatusLabel(heartbeatSnapshot), enabled: false },
      {
        label: `Last run: ${formatHeartbeatTimestamp(heartbeatSnapshot.lastRunAtMs, "Never")}`,
        enabled: false,
      },
      {
        label: `Next run: ${formatHeartbeatTimestamp(heartbeatSnapshot.nextRunAtMs, "Not scheduled")}`,
        enabled: false,
      },
      {
        label: `Heartbeats: ${heartbeatSnapshot.totalHeartbeats} total, ${heartbeatSnapshot.activeHeartbeats} active`,
        enabled: false,
      },
      {
        label: `Executions: ${heartbeatSnapshot.totalExecutions} total, ${heartbeatSnapshot.totalFailures} failed`,
        enabled: false,
      },
    );
  }

  return {
    label,
    submenu: [
      ...baseItems,
      { type: "separator" },
      ...buildOpenWindowItems(
        windows,
        `No open ${label.toLowerCase()} windows`,
      ),
    ],
  };
}

function buildDesktopMenu(): ApplicationMenuItem {
  const appName = getBrandConfig().appName;
  return {
    label: "Desktop",
    submenu: [
      { label: "Desktop Workspace", action: "open-settings-desktop" },
      { label: "Voice Controls", action: "open-settings-voice" },
      { label: "Permissions", action: "open-settings-permissions" },
      { label: "Cloud Settings", action: "open-settings-cloud" },
      { label: "Settings Window", action: "open-settings" },
      { type: "separator" },
      { label: `Show ${appName}`, action: "show" },
      { label: `Focus ${appName}`, action: "focus-main-window" },
      { label: `Hide ${appName}`, action: "hide-main-window" },
      { label: `Maximize ${appName}`, action: "maximize-main-window" },
      { label: `Restore ${appName} Size`, action: "restore-main-window" },
      { type: "separator" },
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

function buildCloudMenu(windows: ManagedWindowSnapshot[]): ApplicationMenuItem {
  return {
    label: "Cloud",
    submenu: [
      { label: "Open Cloud Settings", action: "open-settings-cloud" },
      { type: "separator" },
      { label: "Open Cloud Window", action: "new-window:cloud" },
      { type: "separator" },
      ...buildOpenWindowItems(windows, "No open cloud windows"),
    ],
  };
}

function buildBrowserMenu(
  windows: ManagedWindowSnapshot[],
): ApplicationMenuItem {
  return {
    label: "Browser",
    submenu: [
      { label: "Open Browser Window", action: "new-window:browser" },
      { type: "separator" },
      ...buildOpenWindowItems(windows, "No open browser windows"),
    ],
  };
}

export function buildApplicationMenu({
  isMac,
  browserEnabled,
  heartbeatSnapshot,
  detachedWindows,
  agentReady = true,
}: {
  isMac: boolean;
  browserEnabled: boolean;
  heartbeatSnapshot: HeartbeatMenuSnapshot;
  detachedWindows: ManagedWindowSnapshot[];
  agentReady?: boolean;
}): ApplicationMenuItem[] {
  const appName = getBrandConfig().appName;
  const visibleDetachedWindows = browserEnabled
    ? detachedWindows
    : detachedWindows.filter((window) => window.surface !== "browser");
  const pluginsWindows = visibleDetachedWindows.filter(
    (window) => window.surface === "plugins",
  );
  const chatWindows = visibleDetachedWindows.filter(
    (window) => window.surface === "chat",
  );
  const connectorsWindows = visibleDetachedWindows.filter(
    (window) => window.surface === "connectors",
  );
  const heartbeatWindows = visibleDetachedWindows.filter(
    (window) => window.surface === "triggers",
  );
  const browserWindows = visibleDetachedWindows.filter(
    (window) => window.surface === "browser",
  );
  const cloudWindows = visibleDetachedWindows.filter(
    (window) => window.surface === "cloud",
  );

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
    buildDesktopMenu(),
    ...(agentReady
      ? [
          buildSurfaceMenu("Chat", "chat", chatWindows),
          buildCloudMenu(cloudWindows),
          ...(browserEnabled ? [buildBrowserMenu(browserWindows)] : []),
          buildSurfaceMenu("Plugins", "plugins", pluginsWindows),
          buildSurfaceMenu("Connectors", "connectors", connectorsWindows),
          buildSurfaceMenu(
            "Heartbeats",
            "triggers",
            heartbeatWindows,
            heartbeatSnapshot,
          ),
        ]
      : []),
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
