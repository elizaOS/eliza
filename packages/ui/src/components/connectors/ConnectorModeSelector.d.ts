import { type ConnectorManagementMode } from "./connector-account-options";
export type ConnectorMode = {
    id: string;
    label: string;
    description: string;
    managementMode?: ConnectorManagementMode;
};
/**
 * Returns available modes for each connector based on deployment context.
 */
export declare function getConnectorModes(connectorId: string, options?: {
    elizaCloudConnected?: boolean;
}): ConnectorMode[];
/**
 * Maps connector mode to the plugin ID that ConnectorSetupPanel renders.
 */
export declare function modeToSetupPluginId(connectorId: string, modeId: string): string | null;
export declare function getDefaultConnectorModeId(connectorId: string, modes: ConnectorMode[]): string;
export declare function ConnectorModeSelector({ connectorId, selectedMode, onModeChange, elizaCloudConnected, }: {
    connectorId: string;
    selectedMode: string;
    onModeChange: (modeId: string) => void;
    elizaCloudConnected?: boolean;
}): import("react/jsx-runtime").JSX.Element | null;
/**
 * Hook to manage connector mode state. Reads initial mode from config
 * or defaults to the first available mode.
 */
export declare function useConnectorMode(connectorId: string, options?: {
    elizaCloudConnected?: boolean;
}): {
    modes: ConnectorMode[];
    selectedMode: string;
    setSelectedMode: import("react").Dispatch<import("react").SetStateAction<string>>;
    setupPluginId: string | null;
};
//# sourceMappingURL=ConnectorModeSelector.d.ts.map