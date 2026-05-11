/**
 * Auto-generated canonical action/provider docs for plugin-shell.
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

export const coreActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "SHELL_HISTORY",
      description:
        "Shell command-history router. action=clear wipes the recorded history; action=view returns recent commands; action=disable is reserved.",
      similes: [
        "CLEAR_HISTORY",
        "CLEAR_SHELL_HISTORY",
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "RESET_HISTORY",
        "VIEW_SHELL_HISTORY",
        "SHOW_SHELL_HISTORY",
        "LIST_SHELL_HISTORY",
      ],
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "SHELL_HISTORY",
      description:
        "Shell command-history router. action=clear wipes the recorded history; action=view returns recent commands; action=disable is reserved.",
      similes: [
        "CLEAR_HISTORY",
        "CLEAR_SHELL_HISTORY",
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "RESET_HISTORY",
        "VIEW_SHELL_HISTORY",
        "SHOW_SHELL_HISTORY",
        "LIST_SHELL_HISTORY",
      ],
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "SHELL_HISTORY",
      description:
        "Provides recent shell command history, current working directory, and file operations within the restricted environment",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "SHELL_HISTORY",
      description:
        "Provides recent shell command history, current working directory, and file operations within the restricted environment",
      dynamic: true,
    },
  ],
} as const;

export const coreActionDocs: readonly ActionDoc[] = coreActionsSpec.actions;
export const allActionDocs: readonly ActionDoc[] = allActionsSpec.actions;
export const coreProviderDocs: readonly ProviderDoc[] = coreProvidersSpec.providers;
export const allProviderDocs: readonly ProviderDoc[] = allProvidersSpec.providers;
