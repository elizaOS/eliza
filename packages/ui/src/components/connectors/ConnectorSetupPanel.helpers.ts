/**
 * Registry + resolution helpers for `ConnectorSetupPanel`. Holds the runtime
 * registry that lets plugins register their own setup-panel component for a
 * connector id (normalized to lowercase alphanumerics) instead of editing a
 * hardcoded switch, and the lookups the dispatcher uses to pick a panel.
 */

import type React from "react";
import { getBootConfig } from "../../config/boot-config";
import { parseConnectorAccountManagementPanelPluginId } from "./connector-account-options";
import { resolveConnectorSetupPanelToken } from "./connector-setup-panel-registry";

export function normalizePluginId(pluginId: string): string {
  return pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Connector setup panel registry — allows plugins to register their own
// setup panels at runtime without modifying the hardcoded switch statement.
// ---------------------------------------------------------------------------

export const connectorSetupRegistry = new Map<string, React.ComponentType>();

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
  const normalized = normalizePluginId(pluginId);
  if (parseConnectorAccountManagementPanelPluginId(pluginId)) {
    return true;
  }
  // Plugin-registered panels take precedence over the built-in registry.
  if (connectorSetupRegistry.has(normalized)) {
    return true;
  }
  if (
    normalized.includes("lifeopsbrowser") ||
    normalized.includes("browserbridg")
  ) {
    return Boolean(getBootConfig().lifeOpsBrowserSetupPanel);
  }
  return resolveConnectorSetupPanelToken(normalized) !== null;
}
