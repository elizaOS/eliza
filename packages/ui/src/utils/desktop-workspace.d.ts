export type DesktopClickAuditEntryPoint = "tray" | "command-palette" | "settings:desktop" | "settings:voice" | "settings:media" | "game";
export interface DesktopClickAuditItem {
    id: string;
    entryPoint: DesktopClickAuditEntryPoint;
    label: string;
    expectedAction: string;
    runtimeRequirement: "all" | "desktop";
    coverage: "automated" | "manual";
}
export type DesktopWorkspaceSurface = "chat" | "browser" | "release" | "triggers" | "plugins" | "cloud";
export interface DesktopWorkspaceSurfaceDef {
    id: DesktopWorkspaceSurface;
    label: string;
    description: string;
}
export declare const DESKTOP_WORKSPACE_SURFACES: readonly DesktopWorkspaceSurfaceDef[];
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
    autoLaunch: {
        enabled: boolean;
        openAsHidden: boolean;
    } | null;
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
    paths: Partial<Record<"home" | "downloads" | "documents" | "userData", string>>;
}
export declare function requestDesktopBridge<T>(rpcMethod: string, ipcChannel: string, params?: unknown): Promise<T | null>;
export declare function openDesktopSettingsWindow(tabHint?: string): Promise<void>;
export declare function openDesktopSurfaceWindow(surface: DesktopWorkspaceSurface, options?: {
    browse?: string;
}): Promise<void>;
export declare function loadDesktopWorkspaceSnapshot(): Promise<DesktopWorkspaceSnapshot>;
export declare function formatDesktopWorkspaceSummary(snapshot: DesktopWorkspaceSnapshot): string;
//# sourceMappingURL=desktop-workspace.d.ts.map