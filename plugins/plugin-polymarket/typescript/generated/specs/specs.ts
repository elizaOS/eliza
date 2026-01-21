/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-polymarket.
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
  version: "1.0.0",
  actions: [
    {
      name: "{{user1}}",
      description: "",
      parameters: [],
    },
    {
      name: "{{user1}}",
      description: "",
      parameters: [],
    },
    {
      name: "{{user1}}",
      description: "",
      parameters: [],
    },
    {
      name: "{{user1}}",
      description: "Deep research: [marketQuestion]...",
      parameters: [],
    },
    {
      name: "query",
      description: "Search term for specific markets (e.g.,",
      parameters: [],
    },
    {
      name: "tokenId",
      description: "Polymarket condition token ID to get info for",
      parameters: [],
    },
    {
      name: "tokenId",
      description: "Token ID to trade",
      parameters: [],
    },
    {
      name: "tokenIds",
      description: "Array of Polymarket condition token IDs to fetch depth for",
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "{{user1}}",
      description: "",
      parameters: [],
    },
    {
      name: "{{user1}}",
      description: "",
      parameters: [],
    },
    {
      name: "{{user1}}",
      description: "",
      parameters: [],
    },
    {
      name: "{{user1}}",
      description: "Deep research: [marketQuestion]...",
      parameters: [],
    },
    {
      name: "query",
      description: "Search term for specific markets (e.g.,",
      parameters: [],
    },
    {
      name: "tokenId",
      description: "Polymarket condition token ID to get info for",
      parameters: [],
    },
    {
      name: "tokenId",
      description: "Token ID to trade",
      parameters: [],
    },
    {
      name: "tokenIds",
      description: "Array of Polymarket condition token IDs to fetch depth for",
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "POLYMARKET_PROVIDER",
      description:
        "Provides current Polymarket account state and trading context from the service cache",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "POLYMARKET_PROVIDER",
      description:
        "Provides current Polymarket account state and trading context from the service cache",
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
