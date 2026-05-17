import { type AllPermissionsState, type PermissionId, type PermissionStatus, type PluginInfo } from "../../api";
import type { CapabilityDef, PermissionDef } from "./permission-types";
export interface DesktopPermissionsSnapshot {
    permissions: AllPermissionsState;
    platform: string;
    shellEnabled: boolean;
}
export declare function PermissionRow({ def, status, reason, platform, canRequest, onRequest, onOpenSettings, isShell, shellEnabled, onToggleShell, }: {
    def: PermissionDef;
    status: PermissionStatus;
    reason?: string;
    platform: string;
    canRequest: boolean;
    onRequest: () => void;
    onOpenSettings: () => void;
    isShell: boolean;
    shellEnabled: boolean;
    onToggleShell?: (enabled: boolean) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function CapabilityToggle({ cap, plugin, permissionsGranted, onToggle, }: {
    cap: CapabilityDef;
    plugin: PluginInfo | null;
    permissionsGranted: boolean;
    onToggle: (enabled: boolean) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function useDesktopPermissionsState(): {
    handleOpenSettings: (id: PermissionId) => Promise<void>;
    handleRefresh: () => Promise<DesktopPermissionsSnapshot | null>;
    handleRequest: (id: PermissionId) => Promise<void>;
    handleToggleShell: (enabled: boolean) => Promise<void>;
    loading: boolean;
    permissions: AllPermissionsState | null;
    platform: string;
    refreshing: boolean;
    shellEnabled: boolean;
};
//# sourceMappingURL=permission-controls.d.ts.map