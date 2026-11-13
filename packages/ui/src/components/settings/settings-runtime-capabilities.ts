/**
 * Resolves the host capabilities that affect the canonical Settings surface.
 *
 * Section registration consumes the returned set declaratively; shell chrome
 * consumes the same set for detached-window behavior. Tests may inject probes
 * without forging user agents, viewport sizes, or native globals.
 */
import {
  resolveWindowShellRoute,
  type WindowShellRoute,
} from "../../platform/window-shell";

export type SettingsRuntimeCapability = "detached-settings-shell";

export type SettingsRuntimeCapabilities =
  ReadonlySet<SettingsRuntimeCapability>;

export interface SettingsRuntimeCapabilityProbes {
  readWindowShellRoute: () => WindowShellRoute;
}

const DEFAULT_PROBES: SettingsRuntimeCapabilityProbes = {
  readWindowShellRoute: resolveWindowShellRoute,
};

/** Build one deterministic capability snapshot for a Settings render. */
export function resolveSettingsRuntimeCapabilities(
  probes: SettingsRuntimeCapabilityProbes = DEFAULT_PROBES,
): SettingsRuntimeCapabilities {
  const capabilities = new Set<SettingsRuntimeCapability>();
  if (probes.readWindowShellRoute().mode === "settings") {
    capabilities.add("detached-settings-shell");
  }
  return capabilities;
}

export function settingsRuntimeHasCapability(
  capabilities: SettingsRuntimeCapabilities,
  capability: SettingsRuntimeCapability,
): boolean {
  return capabilities.has(capability);
}
