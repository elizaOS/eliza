/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-goals.
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

const pluginActionStubs: readonly ActionDoc[] = [
  { name: "CANCEL_GOAL", description: "Cancel a goal.", parameters: [] },
  { name: "CREATE_GOAL", description: "Create a new goal.", parameters: [] },
  { name: "UPDATE_GOAL", description: "Update an existing goal.", parameters: [] },
  { name: "CONFIRM_GOAL", description: "Confirm a goal.", parameters: [] },
  { name: "COMPLETE_GOAL", description: "Mark a goal as complete.", parameters: [] },
];

export const coreActionsSpec = {
  version: "1.0.0",
  actions: pluginActionStubs,
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: pluginActionStubs,
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "GOALS",
      description: "Provides information about active goals and recent achievements",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "GOALS",
      description: "Provides information about active goals and recent achievements",
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
