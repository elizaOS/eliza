import type { AppRunSummary, RegistryAppInfo } from "../../api";
interface AppsSidebarProps {
    apps: RegistryAppInfo[];
    browseApps: RegistryAppInfo[];
    runs: AppRunSummary[];
    activeAppNames: ReadonlySet<string>;
    favoriteAppNames: ReadonlySet<string>;
    selectedAppName: string | null;
    /** Controlled collapsed state. */
    collapsed: boolean;
    onCollapsedChange: (next: boolean) => void;
    /** Controlled width in px (expanded only; ignored when collapsed). */
    width: number;
    onWidthChange: (next: number) => void;
    minWidth?: number;
    maxWidth?: number;
    onLaunchApp: (app: RegistryAppInfo) => void;
    onOpenRun: (run: AppRunSummary) => void;
}
export declare function AppsSidebar({ apps, browseApps, runs, activeAppNames, favoriteAppNames, selectedAppName, collapsed, onCollapsedChange, width, onWidthChange, minWidth, maxWidth, onLaunchApp, onOpenRun, }: AppsSidebarProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=AppsSidebar.d.ts.map