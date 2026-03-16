/**
 * Auto-generated canonical action/provider/evaluator docs for plugin-todo.
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
      name: "CANCEL_TODO",
      description: "Cancels and deletes a todo item from the user",
      similes: ["DELETE_TODO", "REMOVE_TASK", "DELETE_TASK", "REMOVE_TODO"],
      parameters: [],
    },
    {
      name: "COMPLETE_TODO",
      description: "Marks a todo item as completed.",
      similes: ["MARK_COMPLETE", "FINISH_TASK", "DONE", "TASK_DONE", "TASK_COMPLETED"],
      parameters: [],
    },
    {
      name: "CONFIRM_TODO",
      description: "Confirms or cancels a pending todo creation after user review.",
      similes: ["CONFIRM_TASK", "APPROVE_TODO", "APPROVE_TASK", "TODO_CONFIRM"],
      parameters: [],
    },
    {
      name: "CREATE_TODO",
      description:
        "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.",
      similes: ["ADD_TODO", "NEW_TASK", "ADD_TASK", "CREATE_TASK"],
      parameters: [],
    },
    {
      name: "UPDATE_TODO",
      description: "Updates an existing todo item immediately based on user description.",
      similes: ["EDIT_TODO", "MODIFY_TASK", "CHANGE_TASK", "MODIFY_TODO", "EDIT_TASK"],
      parameters: [],
    },
  ],
} as const;
export const allActionsSpec = {
  version: "1.0.0",
  actions: [
    {
      name: "CANCEL_TODO",
      description: "Cancels and deletes a todo item from the user",
      similes: ["DELETE_TODO", "REMOVE_TASK", "DELETE_TASK", "REMOVE_TODO"],
      parameters: [],
    },
    {
      name: "COMPLETE_TODO",
      description: "Marks a todo item as completed.",
      similes: ["MARK_COMPLETE", "FINISH_TASK", "DONE", "TASK_DONE", "TASK_COMPLETED"],
      parameters: [],
    },
    {
      name: "CONFIRM_TODO",
      description: "Confirms or cancels a pending todo creation after user review.",
      similes: ["CONFIRM_TASK", "APPROVE_TODO", "APPROVE_TASK", "TODO_CONFIRM"],
      parameters: [],
    },
    {
      name: "CREATE_TODO",
      description:
        "Creates a new todo item from a user description (daily, one-off, or aspirational) immediately.",
      similes: ["ADD_TODO", "NEW_TASK", "ADD_TASK", "CREATE_TASK"],
      parameters: [],
    },
    {
      name: "UPDATE_TODO",
      description: "Updates an existing todo item immediately based on user description.",
      similes: ["EDIT_TODO", "MODIFY_TASK", "CHANGE_TASK", "MODIFY_TODO", "EDIT_TASK"],
      parameters: [],
    },
  ],
} as const;
export const coreProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "TODOS",
      description: "Information about the user",
      dynamic: true,
    },
  ],
} as const;
export const allProvidersSpec = {
  version: "1.0.0",
  providers: [
    {
      name: "TODOS",
      description: "Information about the user",
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
