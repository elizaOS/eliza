/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-shell.
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
export declare const coreActionsSpec: {
  readonly version: "1.0.0";
  readonly actions: readonly [
    {
      readonly name: "CLEAR_SHELL_HISTORY";
      readonly description: "Clears the recorded history of shell commands for the current conversation";
      readonly similes: readonly [
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "CLEAR_HISTORY",
        "RESET_HISTORY",
      ];
      readonly parameters: readonly [];
    },
    {
      readonly name: "EXECUTE_COMMAND";
      readonly description: "Execute shell commands including brew install, npm install, apt-get, system commands, file operations, directory navigation, and scripts.";
      readonly similes: readonly [
        "RUN_COMMAND",
        "SHELL_COMMAND",
        "TERMINAL_COMMAND",
        "EXEC",
        "RUN",
        "EXECUTE",
        "CREATE_FILE",
        "WRITE_FILE",
        "MAKE_FILE",
        "INSTALL",
        "BREW_INSTALL",
        "NPM_INSTALL",
        "APT_INSTALL",
      ];
      readonly parameters: readonly [];
    },
  ];
};
export declare const allActionsSpec: {
  readonly version: "1.0.0";
  readonly actions: readonly [
    {
      readonly name: "CLEAR_SHELL_HISTORY";
      readonly description: "Clears the recorded history of shell commands for the current conversation";
      readonly similes: readonly [
        "RESET_SHELL",
        "CLEAR_TERMINAL",
        "CLEAR_HISTORY",
        "RESET_HISTORY",
      ];
      readonly parameters: readonly [];
    },
    {
      readonly name: "EXECUTE_COMMAND";
      readonly description: "Execute shell commands including brew install, npm install, apt-get, system commands, file operations, directory navigation, and scripts.";
      readonly similes: readonly [
        "RUN_COMMAND",
        "SHELL_COMMAND",
        "TERMINAL_COMMAND",
        "EXEC",
        "RUN",
        "EXECUTE",
        "CREATE_FILE",
        "WRITE_FILE",
        "MAKE_FILE",
        "INSTALL",
        "BREW_INSTALL",
        "NPM_INSTALL",
        "APT_INSTALL",
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
export declare const coreEvaluatorsSpec: {
  readonly version: "1.0.0";
  readonly evaluators: readonly [];
};
export declare const allEvaluatorsSpec: {
  readonly version: "1.0.0";
  readonly evaluators: readonly [];
};
export declare const coreActionDocs: readonly ActionDoc[];
export declare const allActionDocs: readonly ActionDoc[];
export declare const coreProviderDocs: readonly ProviderDoc[];
export declare const allProviderDocs: readonly ProviderDoc[];
export declare const coreEvaluatorDocs: readonly EvaluatorDoc[];
export declare const allEvaluatorDocs: readonly EvaluatorDoc[];
