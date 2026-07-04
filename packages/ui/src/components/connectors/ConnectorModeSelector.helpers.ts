import {
  type ConnectorManagementMode,
  getConnectorSetupDeclaration,
} from "@elizaos/shared";
import {
  CONNECTOR_PLUGIN_MANAGED_MODE_ID,
  connectorAccountManagementPanelPluginId,
  getConnectorPluginManagedAccountOption,
} from "./connector-account-options";

export type { ConnectorManagementMode };

export type ConnectorMode = {
  id: string;
  label: string;
  description: string;
  labelKey?: string;
  descriptionKey?: string;
  managementMode?: ConnectorManagementMode;
  setupPluginId?: string;
};

function withPluginManagedMode(
  connectorId: string,
  modes: ConnectorMode[],
): ConnectorMode[] {
  const option = getConnectorPluginManagedAccountOption(connectorId);
  if (!option) return modes;
  return [
    {
      id: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
      label: option.label,
      description: option.description,
      managementMode: CONNECTOR_PLUGIN_MANAGED_MODE_ID,
    },
    ...modes.filter((mode) => mode.id !== CONNECTOR_PLUGIN_MANAGED_MODE_ID),
  ];
}

/**
 * Returns available modes for each connector based on deployment context.
 * The mode list, copy, cloud gating, and setup routing are declared once in
 * `@elizaos/shared`'s connector setup declarations; this reads that source and
 * prepends the plugin-managed mode when the connector supports it.
 */
export function getConnectorModes(
  connectorId: string,
  options?: { elizaCloudConnected?: boolean },
): ConnectorMode[] {
  const cloud = options?.elizaCloudConnected ?? false;
  const declaration = getConnectorSetupDeclaration(connectorId);

  const modes: ConnectorMode[] = (declaration?.modes ?? [])
    .filter((mode) => !mode.cloudOnly || cloud)
    .map((mode) => ({
      id: mode.id,
      label: mode.labelFallback,
      description: mode.descriptionFallback,
      labelKey: mode.labelKey,
      descriptionKey: mode.descriptionKey,
      managementMode: mode.managementMode,
      setupPluginId: mode.setupPluginId,
    }));

  return withPluginManagedMode(connectorId, modes);
}

/**
 * Maps connector mode to the plugin ID that ConnectorSetupPanel renders.
 */
export function modeToSetupPluginId(
  connectorId: string,
  modeId: string,
): string | null {
  if (modeId === CONNECTOR_PLUGIN_MANAGED_MODE_ID) {
    return connectorAccountManagementPanelPluginId(connectorId);
  }
  const declaration = getConnectorSetupDeclaration(connectorId);
  return (
    declaration?.modes.find((mode) => mode.id === modeId)?.setupPluginId ?? null
  );
}

export function getDefaultConnectorModeId(
  connectorId: string,
  modes: ConnectorMode[],
): string {
  if (modes.some((mode) => mode.id === CONNECTOR_PLUGIN_MANAGED_MODE_ID)) {
    return CONNECTOR_PLUGIN_MANAGED_MODE_ID;
  }
  const preferred =
    getConnectorSetupDeclaration(connectorId)?.preferredDefaultModeIds ?? [];
  for (const modeId of preferred) {
    if (modes.some((mode) => mode.id === modeId)) {
      return modeId;
    }
  }
  return modes[0]?.id ?? "";
}
