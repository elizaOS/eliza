import type { ComponentType } from "react";

export const DESKTOP_TRAY_MENU_ITEMS: readonly Array<Record<string, unknown>>;
export const DesktopOnboardingRuntime: ComponentType;
export const DesktopSurfaceNavigationRuntime: ComponentType;
export const DesktopTrayRuntime: ComponentType;
export const DetachedShellRoot: ComponentType<{ route?: string | null }>;
