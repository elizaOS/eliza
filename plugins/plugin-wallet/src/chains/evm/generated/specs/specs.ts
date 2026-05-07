/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-wallet evm chain.
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
      name: "EVM_TRANSFER",
      description: "Transfer tokens from the agent's EVM wallet to another address",
      descriptionCompressed: "EVM transfer: send native or ERC-20 tokens to another address.",
      similes: [
        "TRANSFER",
        "SEND_TOKENS",
        "SEND_TOKEN",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "EVM_SEND_TOKENS",
      ],
    },
    {
      name: "EVM_SWAP",
      description: "Swap tokens on a decentralized exchange",
      descriptionCompressed: "EVM token swap on a DEX (Lifi/Bebop routing).",
      similes: ["SWAP_TOKENS", "SWAP_TOKEN"],
    },
    {
      name: "CROSS_CHAIN_TRANSFER",
      description: "Bridge tokens to another chain",
      descriptionCompressed: "Bridge ERC-20 tokens between EVM chains via Lifi.",
      similes: ["BRIDGE", "BRIDGE_TOKENS"],
    },
    {
      name: "WALLET_GOV_OP",
      description: "OZ-Governor governance op: { op: 'propose' | 'vote' | 'queue' | 'execute' }",
      descriptionCompressed: "OZ-Governor op: propose, vote, queue, or execute (op switch).",
      similes: [
        "GOV_PROPOSE",
        "GOV_VOTE",
        "GOV_QUEUE",
        "GOV_EXECUTE",
        "GOVERNANCE_VOTE",
        "QUEUE_PROPOSAL",
        "EXECUTE_PROPOSAL",
        "PROPOSE",
      ],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "EVM_TRANSFER",
      description: "Transfer tokens from the agent's EVM wallet to another address",
      descriptionCompressed: "EVM transfer: send native or ERC-20 tokens to another address.",
      similes: [
        "TRANSFER",
        "SEND_TOKENS",
        "SEND_TOKEN",
        "TRANSFER_TOKEN",
        "TRANSFER_TOKENS",
        "EVM_SEND_TOKENS",
      ],
    },
    {
      name: "EVM_SWAP",
      description: "Swap tokens on a decentralized exchange",
      descriptionCompressed: "EVM token swap on a DEX (Lifi/Bebop routing).",
      similes: ["SWAP_TOKENS", "SWAP_TOKEN"],
    },
    {
      name: "CROSS_CHAIN_TRANSFER",
      description: "Bridge tokens to another chain",
      descriptionCompressed: "Bridge ERC-20 tokens between EVM chains via Lifi.",
      similes: ["BRIDGE", "BRIDGE_TOKENS"],
    },
    {
      name: "WALLET_GOV_OP",
      description: "OZ-Governor governance op: { op: 'propose' | 'vote' | 'queue' | 'execute' }",
      descriptionCompressed: "OZ-Governor op: propose, vote, queue, or execute (op switch).",
      similes: [
        "GOV_PROPOSE",
        "GOV_VOTE",
        "GOV_QUEUE",
        "GOV_EXECUTE",
        "GOVERNANCE_VOTE",
        "QUEUE_PROPOSAL",
        "EXECUTE_PROPOSAL",
        "PROPOSE",
      ],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "wallet",
      description: "EVM wallet address and balances",
      descriptionCompressed: "EVM wallet address and balances.",
      dynamic: true,
    },
    {
      name: "get-balance",
      description: "Token balance for ERC20 tokens when onchain actions are requested",
      descriptionCompressed: "ERC20 token balance for onchain actions.",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "wallet",
      description: "EVM wallet address and balances",
      descriptionCompressed: "EVM wallet address and balances.",
      dynamic: true,
    },
    {
      name: "get-balance",
      description: "Token balance for ERC20 tokens when onchain actions are requested",
      descriptionCompressed: "ERC20 token balance for onchain actions.",
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
