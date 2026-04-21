import type { AgentRuntime } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import {
  type EvmSigningCapability,
  type EvmSigningCapabilityKind,
  resolveEvmSigningCapability,
} from "../services/evm-signing-capability.js";
import { isStewardEvmBridgeActive } from "../services/steward-evm-bridge.js";
import { getWalletAddresses } from "./wallet.js";
import { resolveWalletRpcReadiness } from "./wallet-rpc.js";

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
    evmSigningCapability: evmSigning.kind,
    evmSigningReason: evmSigning.reason,
  };
}
