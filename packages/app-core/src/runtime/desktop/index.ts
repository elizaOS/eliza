/**
 * Barrel for the Electrobun desktop runtime: re-exports the app-window renderer,
 * the headless tray/menu and surface-navigation runtimes, the detached-window
 * shell root, and the tray-menu catalog. This is the desktop surface pulled in by
 * the browser-safe app-core entry.
 */
export * from "./AppWindowRenderer";
export * from "./DesktopSurfaceNavigationRuntime";
export * from "./DesktopTrayRuntime";
export * from "./DetachedShellRoot";
export * from "./tray-menu";
