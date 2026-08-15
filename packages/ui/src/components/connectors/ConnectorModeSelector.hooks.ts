/**
 * React state hook for `ConnectorModeSelector`: tracks the selected connector
 * mode, seeds it from the connector's default, and re-defaults when the
 * available mode list changes (e.g. cloud connectivity or hosting changes).
 */

import { useEffect, useState } from "react";
import {
  getConnectorModes,
  getDefaultConnectorModeId,
  modeToSetupPluginId,
} from "./ConnectorModeSelector.helpers";
import type { ConnectorChannelMode } from "./connector-channel-mode";

/**
 * Hook to manage connector mode state. Reads initial mode from config
 * or defaults to the first available mode. When the available mode list
 * changes (Eliza Cloud connects, the global channel-mode lens flips) a
 * selection that is no longer offered re-defaults automatically.
 */
export function useConnectorMode(
  connectorId: string,
  options?: {
    elizaCloudConnected?: boolean;
    cloudProvisioned?: boolean;
    channelMode?: ConnectorChannelMode;
  },
) {
  const modes = getConnectorModes(connectorId, options);
  const defaultMode = getDefaultConnectorModeId(connectorId, modes);
  const [selectedMode, setSelectedMode] = useState(defaultMode);

  useEffect(() => {
    if (!modes.some((mode) => mode.id === selectedMode)) {
      setSelectedMode(defaultMode);
    }
  }, [defaultMode, modes, selectedMode]);

  return {
    modes,
    selectedMode,
    setSelectedMode,
    setupPluginId: modeToSetupPluginId(connectorId, selectedMode),
  };
}
