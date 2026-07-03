import {
  type AutomationNodeContributorContext,
  buildRuntimeCapabilityNodes,
  type RuntimeCapabilityNodeSpec,
  registerAutomationNodeContributor,
} from "@elizaos/app-core/api/automation-node-contributors";
import type { AutomationNodeDescriptor } from "@elizaos/ui";

/**
 * Automation catalog nodes owned by the wallet plugin. These cover EVM + Solana
 * swaps and cross-chain bridges backed by the wallet plugin's runtime actions.
 * They live here (not hardcoded in app-core) so a wallet action rename or plugin
 * name change updates the node in one place with the code it gates.
 */
const WALLET_AUTOMATION_NODE_SPECS: RuntimeCapabilityNodeSpec[] = [
  {
    id: "crypto:evm.swap",
    label: "EVM swap",
    description:
      "EVM token swap automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "SWAP",
    actionNames: ["SWAP", "SWAP_TOKENS", "SWAP_TOKEN"],
    pluginNames: ["evm", "wallet", "plugin-wallet", "@elizaos/plugin-wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with swap support.",
  },
  {
    id: "crypto:evm.bridge",
    label: "EVM bridge",
    description:
      "EVM cross-chain bridge automation backed by a loaded EVM runtime action.",
    class: "action",
    backingCapability: "CROSS_CHAIN_TRANSFER",
    actionNames: ["CROSS_CHAIN_TRANSFER", "BRIDGE", "BRIDGE_TOKENS"],
    pluginNames: ["evm", "wallet", "plugin-wallet", "@elizaos/plugin-wallet"],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the EVM plugin with bridge support.",
  },
  {
    id: "crypto:solana.swap",
    label: "Solana swap",
    description:
      "Solana token swap automation backed by a loaded Solana runtime action.",
    class: "action",
    backingCapability: "SWAP_SOLANA",
    actionNames: [
      "SWAP_SOLANA",
      "SWAP_SOL",
      "SWAP_TOKENS_SOLANA",
      "TOKEN_SWAP_SOLANA",
      "TRADE_TOKENS_SOLANA",
      "EXCHANGE_TOKENS_SOLANA",
    ],
    pluginNames: [
      "chain_solana",
      "solana",
      "wallet",
      "plugin-wallet",
      "@elizaos/plugin-wallet",
    ],
    ownerScoped: true,
    enabledWithoutRuntimeCapability: false,
    disabledReason: "Load the Solana plugin with swap support.",
  },
];

export function buildWalletAutomationNodes({
  runtime,
}: AutomationNodeContributorContext): AutomationNodeDescriptor[] {
  return buildRuntimeCapabilityNodes(WALLET_AUTOMATION_NODE_SPECS, runtime);
}

export function registerWalletAutomationNodeContributor(): void {
  registerAutomationNodeContributor("wallet", buildWalletAutomationNodes);
}
