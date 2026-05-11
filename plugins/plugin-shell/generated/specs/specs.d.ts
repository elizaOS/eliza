/**
 * Auto-generated canonical action/provider docs for plugin-shell.
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
export declare const coreActionsSpec: {
  readonly version: "1.0.0";
  readonly actions: readonly [
    {
      readonly name: "SHELL_HISTORY";
      readonly description: string;
      readonly similes: readonly [
        "CLEAR_HISTORY",
        "CLEAR_SHELL_HISTORY",
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "RESET_HISTORY",
        "VIEW_SHELL_HISTORY",
        "SHOW_SHELL_HISTORY",
        "LIST_SHELL_HISTORY",
      ];
      readonly parameters: readonly [];
    },
  ];
};
export declare const allActionsSpec: {
  readonly version: "1.0.0";
  readonly actions: readonly [
    {
      readonly name: "SHELL_HISTORY";
      readonly description: string;
      readonly similes: readonly [
        "CLEAR_HISTORY",
        "CLEAR_SHELL_HISTORY",
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "RESET_HISTORY",
        "VIEW_SHELL_HISTORY",
        "SHOW_SHELL_HISTORY",
        "LIST_SHELL_HISTORY",
      ];
      readonly parameters: readonly [];
    },
  ];
};
export declare const coreProvidersSpec: {
  readonly version: "1.0.0";
  readonly providers: readonly [
    {
      readonly name: "SHELL_HISTORY";
      readonly description: "Provides recent shell command history, current working directory, and file operations within the restricted environment";
      readonly dynamic: true;
    },
  ];
};
export declare const allProvidersSpec: {
  readonly version: "1.0.0";
  readonly providers: readonly [
    {
      readonly name: "SHELL_HISTORY";
      readonly description: "Provides recent shell command history, current working directory, and file operations within the restricted environment";
      readonly dynamic: true;
    },
  ];
};
export declare const coreActionDocs: readonly ActionDoc[];
export declare const allActionDocs: readonly ActionDoc[];
export declare const coreProviderDocs: readonly ProviderDoc[];
export declare const allProviderDocs: readonly ProviderDoc[];
