/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-n8n.
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
      name: "PLUGIN_CREATION_ACTIONS",
      description: "Create a plugin from a JSON specification",
      similes: ["create plugin", "build plugin", "generate plugin"],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "Create a plugin for managing user preferences",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll create a user preferences management plugin for you.",
              actions: ["PLUGIN_CREATION_ACTIONS"],
            },
          },
        ],
      ],
    },
    {
      name: "CHECK_PLUGIN_CREATION_STATUS",
      description: "Check the status of a plugin creation job",
      similes: [
        "plugin status",
        "check plugin progress",
        "plugin creation status",
        "get plugin status",
      ],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "What's the status of my plugin creation?",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "Let me check the status of your plugin creation job...",
              actions: ["CHECK_PLUGIN_CREATION_STATUS"],
            },
          },
        ],
      ],
    },
    {
      name: "CANCEL_PLUGIN_CREATION",
      description: "Cancel the current plugin creation job",
      similes: ["stop plugin creation", "abort plugin creation", "cancel plugin"],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "Cancel the plugin creation",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll cancel the current plugin creation job.",
              actions: ["CANCEL_PLUGIN_CREATION"],
            },
          },
        ],
      ],
    },
    {
      name: "CREATE_PLUGIN_FROM_DESCRIPTION",
      description: "Create a plugin from a natural language description",
      similes: [
        "describe plugin",
        "plugin from description",
        "explain plugin",
        "I need a plugin that",
      ],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "I need a plugin that helps manage todo lists with add, remove, and list functionality",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll create a todo list management plugin based on your description.",
              actions: ["CREATE_PLUGIN_FROM_DESCRIPTION"],
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
      name: "PLUGIN_CREATION_ACTIONS",
      description: "Create a plugin from a JSON specification",
      similes: ["create plugin", "build plugin", "generate plugin"],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "Create a plugin for managing user preferences",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll create a user preferences management plugin for you.",
              actions: ["PLUGIN_CREATION_ACTIONS"],
            },
          },
        ],
      ],
    },
    {
      name: "CHECK_PLUGIN_CREATION_STATUS",
      description: "Check the status of a plugin creation job",
      similes: [
        "plugin status",
        "check plugin progress",
        "plugin creation status",
        "get plugin status",
      ],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "What's the status of my plugin creation?",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "Let me check the status of your plugin creation job...",
              actions: ["CHECK_PLUGIN_CREATION_STATUS"],
            },
          },
        ],
      ],
    },
    {
      name: "CANCEL_PLUGIN_CREATION",
      description: "Cancel the current plugin creation job",
      similes: ["stop plugin creation", "abort plugin creation", "cancel plugin"],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "Cancel the plugin creation",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll cancel the current plugin creation job.",
              actions: ["CANCEL_PLUGIN_CREATION"],
            },
          },
        ],
      ],
    },
    {
      name: "CREATE_PLUGIN_FROM_DESCRIPTION",
      description: "Create a plugin from a natural language description",
      similes: [
        "describe plugin",
        "plugin from description",
        "explain plugin",
        "I need a plugin that",
      ],
      parameters: [],
      examples: [
        [
          {
            name: "{{name1}}",
            content: {
              text: "I need a plugin that helps manage todo lists with add, remove, and list functionality",
            },
          },
          {
            name: "{{name2}}",
            content: {
              text: "I'll create a todo list management plugin based on your description.",
              actions: ["CREATE_PLUGIN_FROM_DESCRIPTION"],
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
      name: "plugin_creation_status",
      description: "Provides status of active plugin creation jobs",
      dynamic: true,
    },
    {
      name: "plugin_registry",
      description: "Provides information about all created plugins in the current session",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "plugin_creation_status",
      description: "Provides status of active plugin creation jobs",
      dynamic: true,
    },
    {
      name: "plugin_registry",
      description: "Provides information about all created plugins in the current session",
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
