/**
 * Types for fragment execution results
 */

export type ExecutionResultBase = {
  containerId: string;
};

export type ExecutionResultInterpreter = ExecutionResultBase & {
  template: string;
  stdout: string[];
  stderr: string[];
  runtimeError?: {
    message: string;
    name: string;
    traceback?: string;
  };
  cellResults: Array<{
    text?: string;
    data?: unknown;
    type?: string;
  }>;
};

export type ExecutionResultWeb = ExecutionResultBase & {
  template: string;
  url: string;
};

export type ExecutionResult = ExecutionResultInterpreter | ExecutionResultWeb;
