import type { HistoryLike } from "./types";
export type DetachedSurfaceTab = "browser" | "chat" | "release" | "triggers" | "plugins" | "cloud";
export type WindowShellRoute = {
    mode: "main";
} | {
    mode: "settings";
    tab?: string;
} | {
    mode: "surface";
    tab: DetachedSurfaceTab;
} | {
    mode: "pill";
};
export interface DetachedShellTarget {
    settingsSection?: string;
    tab: "browser" | "chat" | "plugins" | "settings" | "triggers";
}
export declare function parseWindowShellRoute(search: string): WindowShellRoute;
export declare function resolveWindowShellRoute(search?: string): WindowShellRoute;
export declare function isDetachedWindowShell(route: WindowShellRoute): route is Exclude<WindowShellRoute, {
    mode: "main";
} | {
    mode: "pill";
}>;
export declare function isPillWindowShell(route: WindowShellRoute): route is Extract<WindowShellRoute, {
    mode: "pill";
}>;
export declare function shouldInstallMainWindowOnboardingPatches(route: WindowShellRoute): boolean;
export declare function resolveDetachedShellTarget(route: WindowShellRoute): DetachedShellTarget;
export declare function resolveDetachedShellPathname(route: WindowShellRoute): string;
export declare function syncDetachedShellLocation(route: WindowShellRoute, args?: {
    history?: HistoryLike | null;
    href?: string;
}): boolean;
//# sourceMappingURL=window-shell.d.ts.map