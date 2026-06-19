/**
 * Auto-generated canonical action/provider docs for plugin-wallet solana chain.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  position?: number;
  dynamic?: boolean;
};

export const coreActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "SOLANA_TRANSFER",
      description: "Transfer SOL or SPL tokens from the agent's Solana wallet to another address",
      descriptionCompressed: "Solana transfer: send SOL or SPL tokens to another address.",
      similes: [
        "TRANSFER",
        "SEND_SOL",
        "SEND_TOKEN",
        "SEND_TOKENS",
        "TRANSFER_SOL",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "PAY",
      ],
      parameters: ["subaction", "chain", "fromToken", "amount", "recipient", "mode", "dryRun"],
    },
    {
      name: "SOLANA_SWAP",
      description:
        "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.",
      descriptionCompressed: "Solana token swap: SOL or SPL tokens via Jupiter routing.",
      similes: [
        "SWAP_SOL",
        "SWAP_SOLANA",
        "SWAP_TOKENS_SOLANA",
        "TOKEN_SWAP_SOLANA",
        "TRADE_TOKENS_SOLANA",
        "EXCHANGE_TOKENS_SOLANA",
      ],
      parameters: [
        "subaction",
        "chain",
        "fromToken",
        "toToken",
        "amount",
        "slippageBps",
        "mode",
        "dryRun",
      ],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "SOLANA_TRANSFER",
      description: "Transfer SOL or SPL tokens from the agent's Solana wallet to another address",
      descriptionCompressed: "Solana transfer: send SOL or SPL tokens to another address.",
      similes: [
        "TRANSFER",
        "SEND_SOL",
        "SEND_TOKEN",
        "SEND_TOKENS",
        "TRANSFER_SOL",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "PAY",
      ],
      parameters: ["subaction", "chain", "fromToken", "amount", "recipient", "mode", "dryRun"],
    },
    {
      name: "SOLANA_SWAP",
      description:
        "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.",
      descriptionCompressed: "Solana token swap: SOL or SPL tokens via Jupiter routing.",
      similes: [
        "SWAP_SOL",
        "SWAP_SOLANA",
        "SWAP_TOKENS_SOLANA",
        "TOKEN_SWAP_SOLANA",
        "TRADE_TOKENS_SOLANA",
        "EXCHANGE_TOKENS_SOLANA",
      ],
      parameters: [
        "subaction",
        "chain",
        "fromToken",
        "toToken",
        "amount",
        "slippageBps",
        "mode",
        "dryRun",
      ],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "solana-wallet",
      description: "your solana wallet information",
      descriptionCompressed: "Solana wallet address, balances, and SPL holdings.",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "solana-wallet",
      description: "your solana wallet information",
      descriptionCompressed: "Solana wallet address, balances, and SPL holdings.",
      dynamic: true,
    },
  ],
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
