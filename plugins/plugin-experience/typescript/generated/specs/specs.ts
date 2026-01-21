/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-experience.
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
      name: "RECORD_EXPERIENCE",
      description:
        "Record a learning or experience for future reference. Use this when the user explicitly asks you to remember something or when you've learned something important.",
      similes: ["REMEMBER", "LEARN", "STORE_EXPERIENCE", "SAVE_EXPERIENCE", "RECORD_LEARNING"],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "Remember that installing dependencies is required for Python scripts",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll record that experience. Learning: Need to install dependencies before running Python scripts.",
              actions: ["RECORD_EXPERIENCE"],
            },
          },
        ],
        [
          {
            name: "{{name1}}",
            content: {
              text: "Remember that users prefer shorter responses",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll remember that preference.",
              actions: ["RECORD_EXPERIENCE"],
            },
          },
        ],
        [
          {
            name: "{{name1}}",
            content: {
              text: "What's 2+2?",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "2+2 equals 4.",
            },
          },
        ],
        [
          {
            name: "{{name1}}",
            content: {
              text: "Can you help me with math?",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "Of course! What math problem do you need help with?",
            },
          },
        ],
      ],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "RECORD_EXPERIENCE",
      description:
        "Record a learning or experience for future reference. Use this when the user explicitly asks you to remember something or when you've learned something important.",
      similes: ["REMEMBER", "LEARN", "STORE_EXPERIENCE", "SAVE_EXPERIENCE", "RECORD_LEARNING"],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "Remember that installing dependencies is required for Python scripts",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll record that experience. Learning: Need to install dependencies before running Python scripts.",
              actions: ["RECORD_EXPERIENCE"],
            },
          },
        ],
        [
          {
            name: "{{name1}}",
            content: {
              text: "Remember that users prefer shorter responses",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll remember that preference.",
              actions: ["RECORD_EXPERIENCE"],
            },
          },
        ],
        [
          {
            name: "{{name1}}",
            content: {
              text: "What's 2+2?",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "2+2 equals 4.",
            },
          },
        ],
        [
          {
            name: "{{name1}}",
            content: {
              text: "Can you help me with math?",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "Of course! What math problem do you need help with?",
            },
          },
        ],
      ],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "experienceProvider",
      description: "Provides relevant past experiences and learnings for the current context",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "experienceProvider",
      description: "Provides relevant past experiences and learnings for the current context",
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
