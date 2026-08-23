/**
 * Pure helpers backing `ConnectorModeSelector`: resolves a connector's ordered
 * setup modes from the connector-mode registry, appends the plugin-managed mode
 * from the connector-account catalog when applicable, filters modes by cloud
 * connectivity and managed-container availability, and maps a selected mode to
 * its setup plugin id.
 */

import {
  CONNECTOR_PLUGIN_MANAGED_MODE_ID,
  type ConnectorManagementMode,
  connectorAccountManagementPanelPluginId,
  getConnectorPluginManagedAccountOption,
} from "./connector-account-options";
import type { ConnectorChannelMode } from "./connector-channel-mode";
import {
  connectorSupportsChannelMode,
  getDeclaredConnectorModes,
} from "./connector-mode-registry";

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
  channelMode?: ConnectorChannelMode,
): ConnectorMode[] {
  const option = getConnectorPluginManagedAccountOption(connectorId);
  if (!option) return modes;
  // Same policy as the Connectors index: a catalog connector classified out of
  // the active lens (e.g. Google under Bot via its fallback) must not expose
  // plugin-managed inventory there. Mixed-role connectors stay available in
  // both lenses; their panel filters records by stored account role.
  if (
    channelMode !== undefined &&
    !connectorSupportsChannelMode(connectorId, channelMode)
  ) {
    return modes;
  }
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
 * modes are filtered out when Eliza Cloud is not connected, and co-located
 * desktop modes can opt out of managed Cloud containers. When a global
 * `channelMode` lens is given, declared modes classified into the *other* lens
 * are filtered out too, and plugin-managed injection follows the same
 * `connectorSupportsChannelMode` policy used by the index/detail surfaces.
 */
export function getConnectorModes(
  connectorId: string,
  options?: {
    elizaCloudConnected?: boolean;
    cloudProvisioned?: boolean;
    channelMode?: ConnectorChannelMode;
  },
): ConnectorMode[] {
  const cloud = options?.elizaCloudConnected ?? false;
  const managedCloud = options?.cloudProvisioned ?? false;
  const lens = options?.channelMode;
  const modes: ConnectorMode[] = getDeclaredConnectorModes(connectorId)
    .filter((mode) => cloud || !mode.cloudOnly)
    .filter((mode) => !managedCloud || !mode.hideOnManagedCloud)
    .filter(
      (mode) =>
        lens === undefined ||
        mode.channelMode === undefined ||
        mode.channelMode === lens,
    )
    .map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      labelKey: mode.labelKey,
      descriptionKey: mode.descriptionKey,
      managementMode: mode.managementMode,
    }));
  return withPluginManagedMode(connectorId, modes, lens);
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

function toPriorityScore(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

function compareConnectorModePriority(
  a: { defaultPriority?: number; id: string },
  b: { defaultPriority?: number; id: string },
): number {
  const aScore = toPriorityScore(a.defaultPriority);
  const bScore = toPriorityScore(b.defaultPriority);
  if (aScore !== bScore) return aScore - bScore;
  return a.id.localeCompare(b.id);
}

export const __testCompareConnectorModePriority = compareConnectorModePriority;

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
    .sort(compareConnectorModePriority)[0];
  return preferred?.id ?? modes[0]?.id ?? "";
}
