import type { ElizaConfig } from "@elizaos/agent/config/config";
import type { AgentRuntime } from "@elizaos/core";
import { isStewardEvmBridgeActive } from "../services/steward-evm-bridge";
import { getWalletAddresses } from "./wallet";
import { resolveWalletRpcReadiness } from "./wallet-rpc";

export const EVM_PLUGIN_PACKAGE = "@elizaos/plugin-evm";

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
}

function hasRuntimeEvmService(runtime: AgentRuntime | null): boolean {
  if (
    !runtime ||
    typeof (runtime as { getService?: unknown }).getService !== "function"
  ) {
    return false;
  }

  try {
    return Boolean(
      (runtime as { getService: (name: string) => unknown }).getService("evm"),
    );
  } catch {
    return false;
  }
}

export function isPluginLoadedByName(
  runtime: AgentRuntime | null,
  pluginName: string,
): boolean {
  if (!runtime || !Array.isArray(runtime.plugins)) return false;
  const shortId = pluginName.replace("@elizaos/plugin-", "");
  const packageSuffix = `plugin-${shortId}`;
  return runtime.plugins.some((plugin) => {
    const name = typeof plugin?.name === "string" ? plugin.name : "";
    return (
      name === pluginName ||
      name === shortId ||
      name === packageSuffix ||
      name.endsWith(`/${packageSuffix}`) ||
      name.includes(shortId)
    );
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
    isStewardEvmBridgeActive()
  );
}

export function resolveWalletCapabilityStatus(state: {
  config: ElizaConfig;
  runtime: AgentRuntime | null;
  getWalletAddresses?: typeof getWalletAddresses;
}): WalletCapabilityStatus {
  const addrs = (state.getWalletAddresses ?? getWalletAddresses)();
  const rpcReadiness = resolveWalletRpcReadiness(state.config);
  const automationMode = resolveWalletAutomationMode(state.config);
  const localSignerAvailable = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
  const hasWallet = Boolean(addrs.evmAddress || addrs.solanaAddress);
  const hasEvm = Boolean(addrs.evmAddress);
  const pluginEvmLoaded = resolvePluginEvmLoaded(state.runtime);
  const pluginEvmRequired = hasEvm || localSignerAvailable;
  const rpcReady = Boolean(rpcReadiness.managedBscRpcReady);
  const walletSource = localSignerAvailable
    ? "local"
    : hasWallet
      ? "managed"
      : "none";

  let executionBlockedReason: string | null = null;
  if (!hasEvm) {
    executionBlockedReason = "No EVM wallet is active yet.";
  } else if (!rpcReady) {
    executionBlockedReason = "BSC RPC is not configured.";
  } else if (!pluginEvmLoaded) {
    executionBlockedReason =
      "plugin-evm is not loaded, so EVM wallet execution is unavailable.";
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
  };
}
