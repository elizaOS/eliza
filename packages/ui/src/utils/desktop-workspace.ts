import { invokeDesktopBridgeRequest, isElectrobunRuntime } from "../bridge";

export type DesktopClickAuditEntryPoint =
  | "tray"
  | "command-palette"
  | "settings:desktop"
  | "settings:voice"
  | "settings:media"
  | "game";

export interface DesktopClickAuditItem {
  id: string;
  entryPoint: DesktopClickAuditEntryPoint;
  label: string;
  expectedAction: string;
  runtimeRequirement: "all" | "desktop";
  coverage: "automated" | "manual";
}

export type DesktopWorkspaceSurface =
  | "chat"
  | "browser"
  | "release"
  | "triggers"
  | "plugins"
  | "connectors"
  | "cloud";

export interface DesktopWorkspaceSurfaceDef {
  id: DesktopWorkspaceSurface;
  label: string;
  description: string;
}

export const DESKTOP_WORKSPACE_SURFACES: readonly DesktopWorkspaceSurfaceDef[] =
  [
    {
      id: "chat",
      label: "Chat Window",
      description: "Open a detached chat session window.",
    },
    {
      id: "release",
      label: "Release Center",
      description: "Open the detached release center window.",
    },
    {
      id: "triggers",
      label: "Heartbeats Window",
      description: "Open scheduled trigger controls in a detached window.",
    },
    {
      id: "plugins",
      label: "Plugins Window",
      description: "Open plugin controls in a detached window.",
    },
    {
      id: "connectors",
      label: "Connectors Window",
      description: "Open connectors in a detached window.",
    },
    {
      id: "cloud",
      label: "Cloud Window",
      description: "Open Eliza Cloud controls in a detached window.",
    },
  ] as const;

export interface DesktopVersionInfo {
  version: string;
  name: string;
  runtime: string;
}

export interface DesktopWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopDisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopDisplayInfo {
  id: number;
  bounds: DesktopDisplayBounds;
  workArea: DesktopDisplayBounds;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface DesktopCursorPosition {
  x: number;
  y: number;
}

export interface DesktopPowerState {
  onBattery: boolean;
  idleState: "active" | "idle" | "locked" | "unknown";
  idleTime: number;
}

export interface DesktopClipboardSnapshot {
  text?: string;
  html?: string;
  rtf?: string;
  hasImage: boolean;
  formats: string[];
}

export interface DesktopWorkspaceSnapshot {
  supported: boolean;
  version: DesktopVersionInfo | null;
  packaged: boolean | null;
  autoLaunch: { enabled: boolean; openAsHidden: boolean } | null;
  window: {
    bounds: DesktopWindowBounds | null;
    maximized: boolean;
    minimized: boolean;
    visible: boolean;
    focused: boolean;
  };
  power: DesktopPowerState | null;
  primaryDisplay: DesktopDisplayInfo | null;
  displays: DesktopDisplayInfo[];
  cursor: DesktopCursorPosition | null;
  clipboard: DesktopClipboardSnapshot | null;
  paths: Partial<
    Record<"home" | "downloads" | "documents" | "userData", string>
  >;
}

function unsupportedSnapshot(): DesktopWorkspaceSnapshot {
  return {
    supported: false,
    version: null,
    packaged: null,
    autoLaunch: null,
    window: {
      bounds: null,
      maximized: false,
      minimized: false,
      visible: false,
      focused: false,
    },
    power: null,
    primaryDisplay: null,
    displays: [],
    cursor: null,
    clipboard: null,
    paths: {},
  };
}

export async function requestDesktopBridge<T>(
  rpcMethod: string,
  ipcChannel: string,
  params?: unknown,
): Promise<T | null> {
  return invokeDesktopBridgeRequest<T>({ rpcMethod, ipcChannel, params });
}

export async function openDesktopSettingsWindow(
  tabHint?: string,
): Promise<void> {
  await requestDesktopBridge<void>(
    "desktopOpenSettingsWindow",
    "desktop:openSettingsWindow",
    tabHint ? { tabHint } : undefined,
  );
}

export async function openDesktopSurfaceWindow(
  surface: DesktopWorkspaceSurface,
  options?: { browse?: string },
): Promise<void> {
  await requestDesktopBridge<void>(
    "desktopOpenSurfaceWindow",
    "desktop:openSurfaceWindow",
    {
      surface,
      ...(surface === "browser" && options?.browse?.trim()
        ? { browse: options.browse.trim() }
        : {}),
    },
  );
}

export async function loadDesktopWorkspaceSnapshot(): Promise<DesktopWorkspaceSnapshot> {
  if (!isElectrobunRuntime()) {
    return unsupportedSnapshot();
  }

  const [
    version,
    packaged,
    autoLaunch,
    windowBounds,
    maximized,
    minimized,
    visible,
    focused,
    power,
    primaryDisplay,
    displays,
    cursor,
    clipboard,
    clipboardFormats,
    home,
    downloads,
    documents,
    userData,
  ] = await Promise.all([
    requestDesktopBridge<DesktopVersionInfo>(
      "desktopGetVersion",
      "desktop:getVersion",
    ),
    requestDesktopBridge<{ packaged: boolean }>(
      "desktopIsPackaged",
      "desktop:isPackaged",
    ),
    requestDesktopBridge<{ enabled: boolean; openAsHidden: boolean }>(
      "desktopGetAutoLaunchStatus",
      "desktop:getAutoLaunchStatus",
    ),
    requestDesktopBridge<DesktopWindowBounds>(
      "desktopGetWindowBounds",
      "desktop:getWindowBounds",
    ),
    requestDesktopBridge<{ maximized: boolean }>(
      "desktopIsWindowMaximized",
      "desktop:isWindowMaximized",
    ),
    requestDesktopBridge<{ minimized: boolean }>(
      "desktopIsWindowMinimized",
      "desktop:isWindowMinimized",
    ),
    requestDesktopBridge<{ visible: boolean }>(
      "desktopIsWindowVisible",
      "desktop:isWindowVisible",
    ),
    requestDesktopBridge<{ focused: boolean }>(
      "desktopIsWindowFocused",
      "desktop:isWindowFocused",
    ),
    requestDesktopBridge<DesktopPowerState>(
      "desktopGetPowerState",
      "desktop:getPowerState",
    ),
    requestDesktopBridge<DesktopDisplayInfo>(
      "desktopGetPrimaryDisplay",
      "desktop:getPrimaryDisplay",
    ),
    requestDesktopBridge<{ displays: DesktopDisplayInfo[] }>(
      "desktopGetAllDisplays",
      "desktop:getAllDisplays",
    ),
    requestDesktopBridge<DesktopCursorPosition>(
      "desktopGetCursorPosition",
      "desktop:getCursorPosition",
    ),
    requestDesktopBridge<{
      text?: string;
      html?: string;
      rtf?: string;
      hasImage: boolean;
    }>("desktopReadFromClipboard", "desktop:readFromClipboard"),
    requestDesktopBridge<{ formats: string[] }>(
      "desktopClipboardAvailableFormats",
      "desktop:clipboardAvailableFormats",
    ),
    requestDesktopBridge<{ path: string }>(
      "desktopGetPath",
      "desktop:getPath",
      {
        name: "home",
      },
    ),
    requestDesktopBridge<{ path: string }>(
      "desktopGetPath",
      "desktop:getPath",
      {
        name: "downloads",
      },
    ),
    requestDesktopBridge<{ path: string }>(
      "desktopGetPath",
      "desktop:getPath",
      {
        name: "documents",
      },
    ),
    requestDesktopBridge<{ path: string }>(
      "desktopGetPath",
      "desktop:getPath",
      {
        name: "userData",
      },
    ),
  ]);

  return {
    supported: true,
    version,
    packaged: packaged?.packaged ?? null,
    autoLaunch,
    window: {
      bounds: windowBounds,
      maximized: maximized?.maximized ?? false,
      minimized: minimized?.minimized ?? false,
      visible: visible?.visible ?? false,
      focused: focused?.focused ?? false,
    },
    power,
    primaryDisplay,
    displays: displays?.displays ?? [],
    cursor,
    clipboard: clipboard
      ? {
          ...clipboard,
          formats: clipboardFormats?.formats ?? [],
        }
      : null,
    paths: {
      home: home?.path,
      downloads: downloads?.path,
      documents: documents?.path,
      userData: userData?.path,
    },
  };
}

function formatBounds(
  bounds: DesktopDisplayBounds | DesktopWindowBounds | null,
) {
  if (!bounds) {
    return "unavailable";
  }
  return `${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y}`;
}

export function formatDesktopWorkspaceSummary(
  snapshot: DesktopWorkspaceSnapshot,
): string {
  if (!snapshot.supported) {
    return "Desktop runtime unavailable";
  }

  return [
    snapshot.version
      ? `${snapshot.version.name} ${snapshot.version.version} (${snapshot.version.runtime})`
      : "Version unavailable",
    snapshot.packaged == null
      ? "Package state unknown"
      : snapshot.packaged
        ? "Packaged"
        : "Development build",
    snapshot.window.visible ? "Window visible" : "Window hidden",
    snapshot.window.focused ? "Window focused" : "Window unfocused",
    snapshot.window.maximized ? "Maximized" : "Windowed",
    snapshot.autoLaunch?.enabled ? "Auto-launch on" : "Auto-launch off",
    snapshot.displays.length > 0
      ? `${snapshot.displays.length} display${snapshot.displays.length === 1 ? "" : "s"}`
      : "No display info",
    snapshot.cursor
      ? `Cursor ${snapshot.cursor.x},${snapshot.cursor.y}`
      : "Cursor unavailable",
    `Bounds ${formatBounds(snapshot.window.bounds)}`,
  ].join(" · ");
}
