/**
 * Pure helpers backing `ConnectorModeSelector`: resolves a connector's ordered
 * setup modes from the connector-mode registry, appends the plugin-managed mode
 * from the connector-account catalog when applicable, filters cloud-only modes
 * by Eliza Cloud connectivity, and maps a selected mode to its setup plugin id.
 */

import {
  CONNECTOR_PLUGIN_MANAGED_MODE_ID,
  type ConnectorManagementMode,
  connectorAccountManagementPanelPluginId,
  getConnectorPluginManagedAccountOption,
} from "./connector-account-options";
import { getDeclaredConnectorModes } from "./connector-mode-registry";

export type ConnectorMode = {
  id: string;
  label: string;
  description: string;
  labelKey?: string;
  descriptionKey?: string;
  managementMode?: ConnectorManagementMode;
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
 * Returns available modes for a connector, rendered generically from the modes
 * the connector plugin declared in the connector-mode registry. Cloud-only
 * modes are filtered out when Eliza Cloud is not connected.
 */
export function getConnectorModes(
  connectorId: string,
  options?: { elizaCloudConnected?: boolean },
): ConnectorMode[] {
  const cloud = options?.elizaCloudConnected ?? false;
  const modes: ConnectorMode[] = getDeclaredConnectorModes(connectorId)
    .filter((mode) => cloud || !mode.cloudOnly)
    .map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      labelKey: mode.labelKey,
      descriptionKey: mode.descriptionKey,
      managementMode: mode.managementMode,
    }));
  return withPluginManagedMode(connectorId, modes);
}

/**
 * Maps a connector mode to the plugin ID that ConnectorSetupPanel renders,
 * from the mode's declared `setupPluginId`.
 */
export function modeToSetupPluginId(
  connectorId: string,
  modeId: string,
): string | null {
  if (modeId === CONNECTOR_PLUGIN_MANAGED_MODE_ID) {
    return connectorAccountManagementPanelPluginId(connectorId);
  }
  return (
    getDeclaredConnectorModes(connectorId).find((mode) => mode.id === modeId)
      ?.setupPluginId ?? null
  );
}

export function getDefaultConnectorModeId(
  connectorId: string,
  modes: ConnectorMode[],
): string {
  if (modes.some((mode) => mode.id === CONNECTOR_PLUGIN_MANAGED_MODE_ID)) {
    return CONNECTOR_PLUGIN_MANAGED_MODE_ID;
  }
  const available = new Set(modes.map((mode) => mode.id));
  const preferred = getDeclaredConnectorModes(connectorId)
    .filter(
      (mode) => mode.defaultPriority !== undefined && available.has(mode.id),
    )
    .sort((a, b) => (a.defaultPriority ?? 0) - (b.defaultPriority ?? 0))[0];
  return preferred?.id ?? modes[0]?.id ?? "";
}
