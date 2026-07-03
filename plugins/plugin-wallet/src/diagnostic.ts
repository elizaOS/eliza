import type { PluginDiagnosticDescriptor } from "@elizaos/core";

/**
 * Static diagnostic descriptor for the EVM wallet plugin. The agent host reads
 * this to render the plugin's diagnostic card generically instead of
 * hardcoding the plugin's identity, config keys, tags, and prerequisites.
 * The runtime-dynamic status (loaded/enabled/prerequisite satisfaction) is
 * resolved by the host and merged with this descriptor.
 *
 * This module is a dependency-free leaf so the host can import it eagerly
 * without pulling in the plugin's runtime (viem, services, etc.).
 */
export const walletDiagnosticDescriptor: PluginDiagnosticDescriptor = {
  id: "evm",
  name: "Plugin EVM",
  description:
    "EVM wallet runtime for balance, transfer, and trade actions. Required for wallet execution in chat.",
  tags: ["wallet", "evm", "bsc", "onchain"],
  envKey: "EVM_PRIVATE_KEY",
  category: "feature",
  source: "bundled",
  configKeys: [
    "EVM_PRIVATE_KEY",
    "BSC_RPC_URL",
    "BSC_TESTNET_RPC_URL",
    "ELIZA_WALLET_NETWORK",
  ],
  npmName: "@elizaos/plugin-wallet",
  managementMode: "core-optional",
  aliases: ["evm", "wallet"],
  prerequisites: [
    { key: "wallet", label: "wallet present" },
    { key: "rpc", label: "rpc ready" },
    { key: "plugin", label: "plugin loaded" },
  ],
};
