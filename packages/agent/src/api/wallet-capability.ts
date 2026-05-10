import type { AgentRuntime } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";
import {
  type EvmSigningCapability,
  type EvmSigningCapabilityKind,
  resolveEvmSigningCapability,
} from "../services/evm-signing-capability.ts";
import { getWalletAddresses } from "./wallet.ts";
import { resolveWalletRpcReadiness } from "./wallet-rpc.ts";

/** Unified wallet package (bundles legacy EVM + Solana plugins). */
export const EVM_PLUGIN_PACKAGE = "@elizaos/plugin-wallet";
const EVM_PLUGIN_SERVICE_NAMES = ["evm", "evmService"] as const;

export interface WalletCapabilityStatus {
  walletSource: "local" | "managed" | "none";
  walletNetwork: "mainnet" | "testnet";
  evmAddress: string | null;
  solanaAddress: string | null;
  hasWallet: boolean;
  hasEvm: boolean;
  localSignerAvailable: boolean;
  rpcReady: boolean;
  automationMode: "full" | "connectors-only";
  pluginEvmLoaded: boolean;
  pluginEvmRequired: boolean;
  executionReady: boolean;
  executionBlockedReason: string | null;
  evmSigningCapability: EvmSigningCapabilityKind;
  evmSigningReason: string;
}

function readPrimaryWalletSource(
  config: ElizaConfig,
  chain: "evm" | "solana",
): "local" | "cloud" | null {
  const wallet =
    config.wallet && typeof config.wallet === "object"
      ? (config.wallet as Record<string, unknown>)
      : null;
  const primary =
    wallet?.primary && typeof wallet.primary === "object"
      ? (wallet.primary as Record<string, unknown>)
      : null;
  const configured = primary?.[chain];
  if (configured === "local" || configured === "cloud") {
    return configured;
  }

  const envKey =
    chain === "evm"
      ? process.env.WALLET_SOURCE_EVM
      : process.env.WALLET_SOURCE_SOLANA;
  return envKey === "local" || envKey === "cloud" ? envKey : null;
}

function hasRuntimeEvmService(runtime: AgentRuntime | null): boolean {
  if (
    !runtime ||
    typeof (runtime as { getService?: unknown }).getService !== "function"
  ) {
    const services = (runtime as { services?: unknown } | null)?.services;
    if (
      services &&
      typeof services === "object" &&
      "get" in services &&
      typeof services.get === "function"
    ) {
      for (const serviceName of EVM_PLUGIN_SERVICE_NAMES) {
        try {
          const instances = services.get(serviceName);
          if (
            (Array.isArray(instances) && instances.length > 0) ||
            (!Array.isArray(instances) && Boolean(instances))
          ) {
            return true;
          }
        } catch {}
      }
    }
    return false;
  }

  try {
    const getService = (runtime as { getService: (name: string) => unknown })
      .getService;
    for (const serviceName of EVM_PLUGIN_SERVICE_NAMES) {
      try {
        if (getService(serviceName)) {
          return true;
        }
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function getRuntimePlugins(runtime: AgentRuntime | null): unknown[] {
  const plugins = (runtime as { plugins?: unknown } | null)?.plugins;
  if (Array.isArray(plugins)) {
    return plugins;
  }
  if (
    plugins &&
    typeof plugins === "object" &&
    "length" in plugins &&
    typeof plugins.length === "number"
  ) {
    return Array.from({ length: plugins.length }, (_, index) => {
      return (plugins as Record<number, unknown>)[index];
    });
  }
  if (
    plugins &&
    typeof plugins === "object" &&
    Symbol.iterator in plugins &&
    typeof plugins[Symbol.iterator] === "function"
  ) {
    try {
      return Array.from(plugins as Iterable<unknown>);
    } catch {
      return [];
    }
  }
  return [];
}

function getPluginIdentifiers(plugin: unknown): string[] {
  if (!plugin || typeof plugin !== "object") {
    return [];
  }

  const record = plugin as Record<string, unknown>;
  return ["name", "id", "packageName", "npmName"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string");
}

function isManagedEvmBridgeActive(): boolean {
  return Boolean(
    process.env.ELIZA_MANAGED_EVM_ADDRESS?.trim() ||
      process.env.ELIZA_CLOUD_EVM_ADDRESS?.trim(),
  );
}

export function isPluginLoadedByName(
  runtime: AgentRuntime | null,
  pluginName: string,
): boolean {
  const shortId = pluginName.replace("@elizaos/plugin-", "");
  const packageSuffix = `plugin-${shortId}`;
  return getRuntimePlugins(runtime).some((plugin) => {
    return getPluginIdentifiers(plugin).some((identifier) => {
      return (
        identifier === pluginName ||
        identifier === shortId ||
        identifier === packageSuffix ||
        identifier.endsWith(`/${packageSuffix}`) ||
        identifier.includes(shortId)
      );
    });
  });
}

export function resolveWalletAutomationMode(
  config: ElizaConfig,
): "full" | "connectors-only" {
  const features =
    config.features && typeof config.features === "object"
      ? (config.features as Record<string, unknown>)
      : null;
  const agentAutomation =
    features?.agentAutomation &&
    typeof features.agentAutomation === "object" &&
    !Array.isArray(features.agentAutomation)
      ? (features.agentAutomation as Record<string, unknown>)
      : null;
  return agentAutomation?.mode === "connectors-only"
    ? "connectors-only"
    : "full";
}

export function resolvePluginEvmLoaded(runtime: AgentRuntime | null): boolean {
  return (
    isPluginLoadedByName(runtime, EVM_PLUGIN_PACKAGE) ||
    hasRuntimeEvmService(runtime) ||
    isManagedEvmBridgeActive()
  );
}

export function resolveWalletCapabilityStatus(state: {
  config: ElizaConfig;
  runtime: AgentRuntime | null;
  getWalletAddresses?: typeof getWalletAddresses;
  resolveEvmSigningCapability?: typeof resolveEvmSigningCapability;
}): WalletCapabilityStatus {
  const addrs = (state.getWalletAddresses ?? getWalletAddresses)();
  const rpcReadiness = resolveWalletRpcReadiness(state.config);
  const automationMode = resolveWalletAutomationMode(state.config);
  const evmSigning: EvmSigningCapability = (
    state.resolveEvmSigningCapability ?? resolveEvmSigningCapability
  )();
  const localSignerAvailable = evmSigning.kind === "local";
  const localSolanaSignerAvailable = Boolean(
    process.env.SOLANA_PRIVATE_KEY?.trim(),
  );
  const hasWallet = Boolean(addrs.evmAddress || addrs.solanaAddress);
  const hasEvm = Boolean(addrs.evmAddress);
  const pluginEvmLoaded = resolvePluginEvmLoaded(state.runtime);
  const pluginEvmRequired = hasEvm || localSignerAvailable;
  const rpcReady = Boolean(rpcReadiness.managedBscRpcReady);
  const primaryEvmSource = readPrimaryWalletSource(state.config, "evm");
  const primarySolanaSource = readPrimaryWalletSource(state.config, "solana");
  const hasCloudPrimary =
    primaryEvmSource === "cloud" || primarySolanaSource === "cloud";
  const hasLocalPrimary =
    primaryEvmSource === "local" || primarySolanaSource === "local";
  const walletSource = hasCloudPrimary
    ? "managed"
    : localSignerAvailable || localSolanaSignerAvailable || hasLocalPrimary
      ? hasWallet || localSignerAvailable || localSolanaSignerAvailable
        ? "local"
        : "none"
      : hasWallet
        ? "managed"
        : "none";

  let executionBlockedReason: string | null = null;
  if (!hasEvm) {
    executionBlockedReason = "No EVM wallet is active yet.";
  } else if (evmSigning.kind === "cloud-view-only") {
    // Prefer the explicit capability reason over a generic "plugin not loaded"
    // so the UI can tell users the cloud wallet is visible but not signable.
    executionBlockedReason = evmSigning.reason;
  } else if (!rpcReady) {
    executionBlockedReason = "BSC RPC is not configured.";
  } else if (!pluginEvmLoaded) {
    executionBlockedReason =
      "@elizaos/plugin-wallet is not loaded, so EVM wallet execution is unavailable.";
  } else if (automationMode !== "full") {
    executionBlockedReason =
      "Agent automation is in connectors-only mode, so wallet execution is blocked in chat.";
  }

  return {
    walletSource,
    walletNetwork: rpcReadiness.walletNetwork,
    evmAddress: addrs.evmAddress ?? null,
    solanaAddress: addrs.solanaAddress ?? null,
    hasWallet,
    hasEvm,
    localSignerAvailable,
    rpcReady,
    automationMode,
    pluginEvmLoaded,
    pluginEvmRequired,
    executionReady:
      hasEvm && rpcReady && pluginEvmLoaded && automationMode === "full",
    executionBlockedReason,
    evmSigningCapability: evmSigning.kind,
    evmSigningReason: evmSigning.reason,
  };
}
