import {
  getSetupPanelPluginIds,
  normalizeConnectorCatalogId,
} from "@elizaos/shared";
import type React from "react";
import { getBootConfig } from "../../config/boot-config";
import { parseConnectorAccountManagementPanelPluginId } from "./connector-account-options";

export function normalizePluginId(pluginId: string): string {
  return pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Connector setup panel registry — the single source of truth for which
// plugin ids have a dedicated React setup panel. First-party panels register
// themselves at module load (see ConnectorSetupPanel.tsx); plugins register
// their own panels at runtime. No hardcoded per-connector-id switch.
// ---------------------------------------------------------------------------

export const connectorSetupRegistry = new Map<string, React.ComponentType>();

/**
 * Resolves the registry key for a plugin id. Fully-qualified telegram plugin
 * ids (`@elizaos/plugin-telegram`, `@elizaos/plugin-telegram-account`)
 * normalize onto their short registry keys so a telegram connector whose mode
 * routing falls through to its own plugin id still resolves the bot panel.
 */
export function resolveConnectorSetupPanelKey(pluginId: string): string {
  const normalized = normalizePluginId(pluginId);
  if (normalized.includes("telegramaccount")) {
    return "telegramaccount";
  }
  if (normalized.includes("plugintelegram")) {
    return "telegram";
  }
  return normalized;
}

/**
 * Register a custom connector setup panel component for a given connector ID.
 * The connectorId is normalized (lowercased, non-alphanumeric stripped) before
 * storage, so callers can pass raw plugin IDs.
 */
export function registerConnectorSetupPanel(
  connectorId: string,
  component: React.ComponentType,
): void {
  connectorSetupRegistry.set(normalizePluginId(connectorId), component);
}

export function hasConnectorSetupPanel(pluginId: string): boolean {
  if (parseConnectorAccountManagementPanelPluginId(pluginId)) {
    return true;
  }
  if (connectorSetupRegistry.has(resolveConnectorSetupPanelKey(pluginId))) {
    return true;
  }
  // First-party connectors declare their setup modes in @elizaos/shared. A
  // connector whose declaration has a local-setup/local-config mode renders a
  // dedicated panel regardless of whether its React panel module has been
  // evaluated yet — the registry check above only covers already-loaded /
  // plugin-registered panels, so relying on it alone re-introduced a load-order
  // regression (#12094-1) that broke first-party panels when the panel
  // component was mocked or not yet imported.
  const declaredPanelIds = getSetupPanelPluginIds();
  if (
    declaredPanelIds.has(normalizeConnectorCatalogId(pluginId)) ||
    declaredPanelIds.has(resolveConnectorSetupPanelKey(pluginId))
  ) {
    return true;
  }
  const normalized = normalizePluginId(pluginId);
  if (
    normalized.includes("lifeopsbrowser") ||
    normalized.includes("browserbridg")
  ) {
    return Boolean(getBootConfig().lifeOpsBrowserSetupPanel);
  }
  return false;
}
