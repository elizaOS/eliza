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
      name: "TRANSFER",
      description: "Transfer tokens from the agent's wallet to another address",
      similes: ["SEND_TOKENS", "SEND_TOKEN", "TRANSFER_TOKEN", "TRANSFER_TOKENS"],
    },
    {
      name: "SWAP",
      description: "Swap tokens on a decentralized exchange",
      similes: ["SWAP_TOKENS", "SWAP_TOKEN"],
    },
    {
      name: "CROSS_CHAIN_TRANSFER",
      description: "Bridge tokens to another chain",
      similes: ["BRIDGE", "BRIDGE_TOKENS"],
    },
    {
      name: "GOV_PROPOSE",
      description: "Create a governance proposal",
    },
    {
      name: "GOV_VOTE",
      description: "Vote on a governance proposal",
    },
    {
      name: "GOV_QUEUE",
      description: "Queue a governance proposal",
    },
    {
      name: "GOV_EXECUTE",
      description: "Execute a governance proposal",
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "TRANSFER",
      description: "Transfer tokens from the agent's wallet to another address",
      similes: ["SEND_TOKENS", "SEND_TOKEN", "TRANSFER_TOKEN", "TRANSFER_TOKENS"],
    },
    {
      name: "SWAP",
      description: "Swap tokens on a decentralized exchange",
      similes: ["SWAP_TOKENS", "SWAP_TOKEN"],
    },
    {
      name: "CROSS_CHAIN_TRANSFER",
      description: "Bridge tokens to another chain",
      similes: ["BRIDGE", "BRIDGE_TOKENS"],
    },
    {
      name: "GOV_PROPOSE",
      description: "Create a governance proposal",
    },
    {
      name: "GOV_VOTE",
      description: "Vote on a governance proposal",
    },
    {
      name: "GOV_QUEUE",
      description: "Queue a governance proposal",
    },
    {
      name: "GOV_EXECUTE",
      description: "Execute a governance proposal",
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "wallet",
      description: "EVM wallet address and balances",
      dynamic: true,
    },
    {
      name: "get-balance",
      description: "Token balance for ERC20 tokens when onchain actions are requested",
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
      dynamic: true,
    },
    {
      name: "get-balance",
      description: "Token balance for ERC20 tokens when onchain actions are requested",
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
