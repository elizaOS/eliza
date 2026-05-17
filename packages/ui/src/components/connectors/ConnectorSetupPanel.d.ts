import type React from "react";
/**
 * Register a custom connector setup panel component for a given connector ID.
 * The connectorId is normalized (lowercased, non-alphanumeric stripped) before
 * storage, so callers can pass raw plugin IDs.
 */
export declare function registerConnectorSetupPanel(connectorId: string, component: React.ComponentType): void;
export declare function hasConnectorSetupPanel(pluginId: string): boolean;
export declare function ConnectorSetupPanel({ pluginId }: {
    pluginId: string;
}): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=ConnectorSetupPanel.d.ts.map