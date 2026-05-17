/**
 * useDesktopTabs — persisted desktop tab state for the Electrobun shell.
 *
 * Tabs are stored in localStorage under "elizaos.desktop.pinned-tabs" so they
 * survive app restarts. Only the Electrobun desktop shell uses this hook; on
 * web and mobile it is a no-op (empty list, inert methods).
 */
import type { ViewRegistryEntry } from "./useAvailableViews";
export interface DesktopTab {
    viewId: string;
    label: string;
    path: string;
    icon?: string;
    /** Pinned tabs persist to localStorage and survive restarts. */
    pinned: boolean;
}
export interface UseDesktopTabsResult {
    tabs: DesktopTab[];
    openTab(view: ViewRegistryEntry): void;
    closeTab(viewId: string): void;
    pinTab(viewId: string): void;
}
export declare function useDesktopTabs(): UseDesktopTabsResult;
//# sourceMappingURL=useDesktopTabs.d.ts.map