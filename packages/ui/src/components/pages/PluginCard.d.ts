import type { PluginInfo } from "../../api";
export interface PluginCardProps {
    plugin: PluginInfo;
    allowCustomOrder: boolean;
    pluginSettingsOpen: Set<string>;
    togglingPlugins: Set<string>;
    hasPluginToggleInFlight: boolean;
    installingPlugins: Set<string>;
    updatingPlugins: Set<string>;
    uninstallingPlugins: Set<string>;
    installProgress: Map<string, {
        phase: string;
        message: string;
    }>;
    releaseStreamSelections: Record<string, "latest" | "beta">;
    draggingId: string | null;
    dragOverId: string | null;
    pluginDescriptionFallback: string;
    onToggle: (pluginId: string, enabled: boolean) => void;
    onToggleSettings: (pluginId: string) => void;
    onInstall: (pluginId: string, npmName: string) => void;
    onUpdate: (pluginId: string, npmName: string) => void;
    onUninstall: (pluginId: string, npmName: string) => void;
    onReleaseStreamChange: (pluginId: string, stream: "latest" | "beta") => void;
    onOpenExternalUrl: (url: string) => void;
    onDragStart?: (e: React.DragEvent, pluginId: string) => void;
    onDragOver?: (e: React.DragEvent, pluginId: string) => void;
    onDrop?: (e: React.DragEvent, pluginId: string) => void;
    onDragEnd?: () => void;
    installProgressLabel: (message?: string) => string;
    installLabel: string;
    loadFailedLabel: string;
    notInstalledLabel: string;
}
export declare function PluginCard({ plugin: p, allowCustomOrder, pluginSettingsOpen, togglingPlugins, hasPluginToggleInFlight, installingPlugins, updatingPlugins, uninstallingPlugins, installProgress, releaseStreamSelections, draggingId, dragOverId, pluginDescriptionFallback, onToggle, onToggleSettings, onInstall, onUpdate, onUninstall, onReleaseStreamChange, onOpenExternalUrl, onDragStart, onDragOver, onDrop, onDragEnd, installProgressLabel, installLabel, loadFailedLabel, notInstalledLabel, }: PluginCardProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=PluginCard.d.ts.map