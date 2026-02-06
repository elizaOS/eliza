import type { Action, ActionExample } from "@elizaos/core";
import { executeWorkflowAction, validateWorkflowService } from "./workflowActionHelper";

export const deleteWorkflowAction: Action = {
  name: "DELETE_N8N_WORKFLOW",
  similes: ["DELETE_WORKFLOW", "REMOVE_WORKFLOW", "DESTROY_WORKFLOW"],
  description:
    "Permanently delete an n8n workflow. This action cannot be undone. " +
    "Only use when the user explicitly asks to delete, remove, or destroy a workflow. " +
    "Do NOT use this for deactivating/pausing — use DEACTIVATE_N8N_WORKFLOW instead.",

  validate: async (runtime) => validateWorkflowService(runtime),

  handler: async (runtime, message, state, _options, callback) =>
    executeWorkflowAction({
      runtime,
      message,
      state,
      callback,
      actionLabel: "delete",
      noWorkflowsMessage: "No workflows available to delete.",
      execute: async (service, workflowId) => {
        await service.deleteWorkflow(workflowId);
        return "Workflow deleted permanently.";
      },
    }),

  examples: [
    [
      { name: "{{user1}}", content: { text: "Delete the old payment workflow" } },
      {
        name: "{{agent}}",
        content: { text: "I'll delete that workflow for you.", actions: ["DELETE_N8N_WORKFLOW"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Remove workflow abc123" } },
      {
        name: "{{agent}}",
        content: { text: "Deleting workflow abc123.", actions: ["DELETE_N8N_WORKFLOW"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Get rid of the broken email automation" } },
      {
        name: "{{agent}}",
        content: { text: "Removing that workflow.", actions: ["DELETE_N8N_WORKFLOW"] },
      },
    ],
  ] as ActionExample[][],
};
