/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-wallet solana chain.
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

export type EvaluatorDoc = {
  name: string;
  description: string;
  descriptionCompressed?: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly unknown[];
};

export const coreActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "TRANSFER",
      description: "Transfer SOL or SPL tokens from the agent's Solana wallet to another address",
      similes: [
        "SEND_SOL",
        "SEND_TOKEN",
        "SEND_TOKENS",
        "TRANSFER_SOL",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "PAY",
      ],
      parameters: [],
    },
    {
      name: "SWAP_SOLANA",
      description:
        "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.",
      similes: [
        "SWAP_SOL",
        "SWAP_TOKENS_SOLANA",
        "TOKEN_SWAP_SOLANA",
        "TRADE_TOKENS_SOLANA",
        "EXCHANGE_TOKENS_SOLANA",
      ],
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "TRANSFER",
      description: "Transfer SOL or SPL tokens from the agent's Solana wallet to another address",
      similes: [
        "SEND_SOL",
        "SEND_TOKEN",
        "SEND_TOKENS",
        "TRANSFER_SOL",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "PAY",
      ],
      parameters: [],
    },
    {
      name: "SWAP_SOLANA",
      description:
        "Perform a token swap from one token to another on Solana. Works with SOL and SPL tokens.",
      similes: [
        "SWAP_SOL",
        "SWAP_TOKENS_SOLANA",
        "TOKEN_SWAP_SOLANA",
        "TRADE_TOKENS_SOLANA",
        "EXCHANGE_TOKENS_SOLANA",
      ],
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "solana-wallet",
      description: "your solana wallet information",
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
      dynamic: true,
    },
  ],
} as const;
export const coreEvaluatorsSpec = {
  version: "1.0.0",
  evaluators: [],
} as const;
export const allEvaluatorsSpec = {
  version: "1.0.0",
  evaluators: [],
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] = coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] = allEvaluatorsSpec.evaluators;
