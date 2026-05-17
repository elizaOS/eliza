import type { ReactNode, RefCallback } from "react";
import type { PluginInfo } from "../../api";
import type { PluginsViewMode, SubgroupTag, TranslateFn } from "./plugin-list-utils";
type RenderResolvedIconOptions = {
    className?: string;
    emojiClassName?: string;
};
interface ConnectorDesktopSidebarProps {
    collapseLabel: string;
    connectorExpandedIds: Set<string>;
    connectorSelectedId: string | null;
    desktopConnectorLayout: boolean;
    expandLabel: string;
    hasPluginToggleInFlight: boolean;
    mode: PluginsViewMode;
    pluginSearch: string;
    registerConnectorRailItem: (pluginId: string) => RefCallback<HTMLElement>;
    registerConnectorSidebarItem: (pluginId: string) => RefCallback<HTMLElement>;
    registerConnectorSidebarViewport: RefCallback<HTMLElement>;
    renderResolvedIcon: (plugin: PluginInfo, options?: RenderResolvedIconOptions) => ReactNode;
    resultLabel: string;
    subgroupFilter: string;
    subgroupTags: SubgroupTag[];
    t: TranslateFn;
    togglingPlugins: Set<string>;
    visiblePlugins: PluginInfo[];
    onConnectorSelect: (pluginId: string) => void;
    onConnectorSectionToggle: (pluginId: string) => void;
    onSearchChange: (value: string) => void;
    onSearchClear: () => void;
    onSubgroupFilterChange: (value: string) => void;
    onTogglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
}
export declare function ConnectorSidebar({ collapseLabel, connectorExpandedIds, connectorSelectedId, desktopConnectorLayout, expandLabel, hasPluginToggleInFlight, mode, pluginSearch, registerConnectorRailItem, registerConnectorSidebarItem, registerConnectorSidebarViewport, renderResolvedIcon, resultLabel, subgroupFilter, subgroupTags, t, togglingPlugins, visiblePlugins, onConnectorSelect, onConnectorSectionToggle, onSearchChange, onSearchClear, onSubgroupFilterChange, onTogglePlugin, }: ConnectorDesktopSidebarProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=plugin-view-sidebar.d.ts.map