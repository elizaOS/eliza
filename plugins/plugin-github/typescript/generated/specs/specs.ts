/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-github.
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
      name: "CREATE_GITHUB_BRANCH",
      description: "",
      parameters: [],
    },
    {
      name: "CREATE_GITHUB_COMMENT",
      description: "",
      parameters: [],
    },
    {
      name: "CREATE_GITHUB_ISSUE",
      description: "",
      parameters: [],
    },
    {
      name: "CREATE_GITHUB_PULL_REQUEST",
      description: "",
      parameters: [],
    },
    {
      name: "MERGE_GITHUB_PULL_REQUEST",
      description: "",
      parameters: [],
    },
    {
      name: "PUSH_GITHUB_CODE",
      description: "",
      parameters: [],
    },
    {
      name: "REVIEW_GITHUB_PULL_REQUEST",
      description: "",
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "CREATE_GITHUB_BRANCH",
      description: "",
      parameters: [],
    },
    {
      name: "CREATE_GITHUB_COMMENT",
      description: "",
      parameters: [],
    },
    {
      name: "CREATE_GITHUB_ISSUE",
      description: "",
      parameters: [],
    },
    {
      name: "CREATE_GITHUB_PULL_REQUEST",
      description: "",
      parameters: [],
    },
    {
      name: "MERGE_GITHUB_PULL_REQUEST",
      description: "",
      parameters: [],
    },
    {
      name: "PUSH_GITHUB_CODE",
      description: "",
      parameters: [],
    },
    {
      name: "REVIEW_GITHUB_PULL_REQUEST",
      description: "",
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "GITHUB_ISSUE_CONTEXT",
      description:
        "Provides detailed context about a specific GitHub issue or pull request when referenced",
      dynamic: true,
    },
    {
      name: "GITHUB_REPOSITORY_STATE",
      description: "Provides context about the current GitHub repository including recent activity",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "GITHUB_ISSUE_CONTEXT",
      description:
        "Provides detailed context about a specific GitHub issue or pull request when referenced",
      dynamic: true,
    },
    {
      name: "GITHUB_REPOSITORY_STATE",
      description: "Provides context about the current GitHub repository including recent activity",
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
