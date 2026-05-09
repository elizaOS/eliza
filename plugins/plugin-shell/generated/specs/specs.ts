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
      name: "CLEAR_SHELL_HISTORY",
      description: "Clears the recorded history of shell commands for the current conversation",
      similes: ["RESET_SHELL", "CLEAR_TERMINAL", "CLEAR_HISTORY", "RESET_HISTORY"],
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "CLEAR_SHELL_HISTORY",
      description: "Clears the recorded history of shell commands for the current conversation",
      similes: ["RESET_SHELL", "CLEAR_TERMINAL", "CLEAR_HISTORY", "RESET_HISTORY"],
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
