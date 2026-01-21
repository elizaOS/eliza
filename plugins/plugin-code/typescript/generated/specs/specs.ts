/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-code.
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
      name: "CHANGE_DIRECTORY",
      description:
        "Change the working directory (restricted to allowed directory).",
      similes: ["CD", "CWD"],
      parameters: [],
    },
    {
      name: "EDIT_FILE",
      description: "Replace a substring in a file (single replacement).",
      similes: ["REPLACE_IN_FILE", "PATCH_FILE", "MODIFY_FILE"],
      parameters: [],
    },
    {
      name: "EXECUTE_SHELL",
      description:
        "Execute a shell command in the current working directory (restricted).",
      similes: ["SHELL", "RUN_COMMAND", "EXEC", "TERMINAL"],
      parameters: [],
    },
    {
      name: "GIT",
      description: "Run a git command (restricted).",
      similes: ["GIT_COMMAND", "GIT_RUN"],
      parameters: [],
    },
    {
      name: "LIST_FILES",
      description: "List files in a directory.",
      similes: ["LS", "LIST_DIR", "LIST_DIRECTORY", "DIR"],
      parameters: [],
    },
    {
      name: "READ_FILE",
      description: "Read and return a file",
      similes: ["VIEW_FILE", "OPEN_FILE", "CAT_FILE", "SHOW_FILE", "GET_FILE"],
      parameters: [],
    },
    {
      name: "SEARCH_FILES",
      description: "Search for text across files under a directory.",
      similes: ["GREP", "RG", "FIND_IN_FILES", "SEARCH"],
      parameters: [],
    },
    {
      name: "WRITE_FILE",
      description: "Create or overwrite a file with given content.",
      similes: ["CREATE_FILE", "SAVE_FILE", "OUTPUT_FILE"],
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "CHANGE_DIRECTORY",
      description:
        "Change the working directory (restricted to allowed directory).",
      similes: ["CD", "CWD"],
      parameters: [],
    },
    {
      name: "EDIT_FILE",
      description: "Replace a substring in a file (single replacement).",
      similes: ["REPLACE_IN_FILE", "PATCH_FILE", "MODIFY_FILE"],
      parameters: [],
    },
    {
      name: "EXECUTE_SHELL",
      description:
        "Execute a shell command in the current working directory (restricted).",
      similes: ["SHELL", "RUN_COMMAND", "EXEC", "TERMINAL"],
      parameters: [],
    },
    {
      name: "GIT",
      description: "Run a git command (restricted).",
      similes: ["GIT_COMMAND", "GIT_RUN"],
      parameters: [],
    },
    {
      name: "LIST_FILES",
      description: "List files in a directory.",
      similes: ["LS", "LIST_DIR", "LIST_DIRECTORY", "DIR"],
      parameters: [],
    },
    {
      name: "READ_FILE",
      description: "Read and return a file",
      similes: ["VIEW_FILE", "OPEN_FILE", "CAT_FILE", "SHOW_FILE", "GET_FILE"],
      parameters: [],
    },
    {
      name: "SEARCH_FILES",
      description: "Search for text across files under a directory.",
      similes: ["GREP", "RG", "FIND_IN_FILES", "SEARCH"],
      parameters: [],
    },
    {
      name: "WRITE_FILE",
      description: "Create or overwrite a file with given content.",
      similes: ["CREATE_FILE", "SAVE_FILE", "OUTPUT_FILE"],
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "CODER_STATUS",
      description:
        "Provides current working directory, allowed directory, and recent shell/file operations",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "CODER_STATUS",
      description:
        "Provides current working directory, allowed directory, and recent shell/file operations",
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
export const coreProviderDocs: readonly ProviderDoc[] =
  coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] =
  allProvidersSpec.providers;
export const coreEvaluatorDocs: readonly EvaluatorDoc[] =
  coreEvaluatorsSpec.evaluators;
export const allEvaluatorDocs: readonly EvaluatorDoc[] =
  allEvaluatorsSpec.evaluators;
