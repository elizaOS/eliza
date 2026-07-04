/**
 * Merges a plugin-owned static diagnostic descriptor with host-resolved runtime
 * status into the `PluginEntry` shape the dashboard diagnostics card renders.
 * The generic `buildPluginDiagnosticEntry` carries no plugin-specific literals —
 * the descriptor supplies identity, config keys, tags, and prerequisite labels;
 * the status supplies live enabled/configured/capability state.
 * `resolveWalletDiagnosticStatus` is the one wallet-aware resolver, mapping the
 * wallet capability snapshot onto that generic status contract.
 */
import type { AgentRuntime, PluginDiagnosticDescriptor } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";
import type { PluginEntry } from "./server-types.ts";
import { resolveWalletCapabilityStatus } from "./wallet-capability.ts";

/**
 * Runtime-dynamic status the host resolves for a plugin diagnostic descriptor.
 * Merged with the plugin-owned static descriptor to render the diagnostic card.
 */
export interface PluginDiagnosticRuntimeStatus {
  enabled: boolean;
  configured: boolean;
  isActive: boolean;
  autoEnabled: boolean;
  capabilityStatus: NonNullable<PluginEntry["capabilityStatus"]>;
  capabilityReason: string | null;
  /** Satisfied state keyed by `PluginDiagnosticPrerequisite.key`. */
  prerequisiteMet: Record<string, boolean>;
}

/**
 * Generic renderer: merges a plugin-owned static descriptor with host-resolved
 * runtime status into the `PluginEntry` the diagnostics card consumes. No
 * plugin-specific literals live here — the descriptor supplies identity, config
 * keys, tags, and prerequisite labels; the status supplies the live state.
 */
export function buildPluginDiagnosticEntry(
  descriptor: PluginDiagnosticDescriptor,
  status: PluginDiagnosticRuntimeStatus,
): PluginEntry {
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    tags: [...descriptor.tags],
    enabled: status.enabled,
    configured: status.configured,
    envKey: descriptor.envKey,
    category: descriptor.category,
    source: descriptor.source,
    configKeys: [...descriptor.configKeys],
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    npmName: descriptor.npmName,
    isActive: status.isActive,
    autoEnabled: status.autoEnabled,
    managementMode: descriptor.managementMode,
    capabilityStatus: status.capabilityStatus,
    capabilityReason: status.capabilityReason,
    prerequisites: descriptor.prerequisites.map((prerequisite) => ({
      label: prerequisite.label,
      met: status.prerequisiteMet[prerequisite.key] ?? false,
    })),
  };
}

/**
 * Wallet-specific status resolver: maps the host's wallet capability snapshot
 * onto the generic diagnostic status for the EVM wallet descriptor. This is the
 * only wallet-aware glue; it lives beside the wallet capability engine, not in
 * the generic host router.
 */
export function resolveWalletDiagnosticStatus(
  descriptor: PluginDiagnosticDescriptor,
  state: { config: ElizaConfig; runtime: AgentRuntime | null },
): PluginDiagnosticRuntimeStatus {
  const capability = resolveWalletCapabilityStatus(state);
  const allow = state.config.plugins?.allow ?? [];
  const enabled =
    capability.pluginEvmLoaded ||
    capability.pluginEvmRequired ||
    allow.some(
      (entry) =>
        entry === descriptor.npmName || descriptor.aliases.includes(entry),
    );

  const capabilityStatus: PluginDiagnosticRuntimeStatus["capabilityStatus"] =
    capability.pluginEvmLoaded
      ? capability.pluginEvmRequired
        ? "loaded"
        : "auto-enabled"
      : enabled
        ? capability.evmAddress || capability.localSignerAvailable
          ? "blocked"
          : "missing-prerequisites"
        : "disabled";

  return {
    enabled,
    configured: capability.pluginEvmRequired,
    isActive: capability.pluginEvmLoaded,
    autoEnabled: capability.pluginEvmRequired && !capability.pluginEvmLoaded,
    capabilityStatus,
    capabilityReason: capability.executionReady
      ? "Wallet execution is ready."
      : capability.executionBlockedReason,
    prerequisiteMet: {
      wallet: Boolean(capability.evmAddress),
      rpc: capability.rpcReady,
      plugin: capability.pluginEvmLoaded,
    },
  };
}
