/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-evm.
 * DO NOT EDIT - Generated from prompts/specs/**.
 */

export type ActionDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  parameters?: readonly unknown[];
  examples?: readonly (readonly unknown[])[];
};

export type ProviderDoc = {
  name: string;
  description: string;
  position?: number;
  dynamic?: boolean;
};

export type EvaluatorDoc = {
  name: string;
  description: string;
  similes?: readonly string[];
  alwaysRun?: boolean;
  examples?: readonly unknown[];
};

export const coreActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "assistant",
      "description": "",
      "parameters": []
    },
    {
      "name": "TRANSFER",
      "description": "Transfer tokens or native asset to an address",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SWAP_TOKENS",
      "description": "Swap tokens via DEX or aggregator",
      "parameters": [],
      "similes": []
    },
    {
      "name": "BRIDGE",
      "description": "Bridge assets across chains",
      "parameters": [],
      "similes": []
    },
    {
      "name": "VOTE_PROPOSAL",
      "description": "Vote on a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "QUEUE_PROPOSAL",
      "description": "Queue a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_PROPOSE",
      "description": "Create a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_EXECUTE",
      "description": "Execute a passed governance proposal",
      "parameters": [],
      "similes": []
    }
  ]
} as const;
export const allActionsSpec = {
  "version": "1.0.0",
  "actions": [
    {
      "name": "assistant",
      "description": "",
      "parameters": []
    },
    {
      "name": "TRANSFER",
      "description": "Transfer tokens or native asset to an address",
      "parameters": [],
      "similes": []
    },
    {
      "name": "SWAP_TOKENS",
      "description": "Swap tokens via DEX or aggregator",
      "parameters": [],
      "similes": []
    },
    {
      "name": "BRIDGE",
      "description": "Bridge assets across chains",
      "parameters": [],
      "similes": []
    },
    {
      "name": "VOTE_PROPOSAL",
      "description": "Vote on a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "QUEUE_PROPOSAL",
      "description": "Queue a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_PROPOSE",
      "description": "Create a governance proposal",
      "parameters": [],
      "similes": []
    },
    {
      "name": "GOV_EXECUTE",
      "description": "Execute a passed governance proposal",
      "parameters": [],
      "similes": []
    }
  ]
} as const;
export const coreProvidersSpec = {
  "version": "1.0.0",
  "providers": [
    {
      "name": "EVMWalletProvider",
      "description": "",
      "dynamic": true
    },
    {
      "name": "TOKEN_BALANCE",
      "description": "Token balance for ERC20 tokens when onchain actions are requested",
      "dynamic": true
    }
  ]
} as const;
export const allProvidersSpec = {
  "version": "1.0.0",
  "providers": [
    {
      "name": "EVMWalletProvider",
      "description": "",
      "dynamic": true
    },
    {
      "name": "TOKEN_BALANCE",
      "description": "Token balance for ERC20 tokens when onchain actions are requested",
      "dynamic": true
    }
  ]
} as const;
export const coreEvaluatorsSpec = {
  "version": "1.0.0",
  "evaluators": []
} as const;
export const allEvaluatorsSpec = {
  "version": "1.0.0",
  "evaluators": []
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] = coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] = allEvaluatorsSpec.evaluators;
