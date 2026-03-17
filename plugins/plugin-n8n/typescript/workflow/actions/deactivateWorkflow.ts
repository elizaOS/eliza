import type { Action, ActionExample } from "@elizaos/core";
import { executeWorkflowAction, validateWorkflowService } from "./workflowActionHelper";

export const deactivateWorkflowAction: Action = {
  name: "DEACTIVATE_N8N_WORKFLOW",
  similes: [
    "DEACTIVATE_WORKFLOW",
    "DISABLE_WORKFLOW",
    "STOP_WORKFLOW",
    "PAUSE_WORKFLOW",
    "TURN_OFF_WORKFLOW",
  ],
  description:
    "Pause an n8n workflow to stop it from running automatically. The workflow is preserved and can be reactivated later. " +
    "Use this when the user wants to temporarily stop, pause, or disable a workflow. " +
    "Does NOT delete the workflow — use DELETE_N8N_WORKFLOW for permanent removal.",

  validate: async (runtime) => validateWorkflowService(runtime),

  handler: async (runtime, message, state, _options, callback) =>
    executeWorkflowAction({
      runtime,
      message,
      state,
      callback,
      actionLabel: "deactivate",
      noWorkflowsMessage: "No workflows available to deactivate.",
      execute: async (service, workflowId) => {
        await service.deactivateWorkflow(workflowId);
        return "Workflow deactivated. It will no longer run automatically but can be reactivated at any time.";
      },
    }),

  examples: [
    [
      { name: "{{user1}}", content: { text: "Pause my Stripe workflow" } },
      {
        name: "{{agent}}",
        content: {
          text: "I'll deactivate that workflow for you.",
          actions: ["DEACTIVATE_N8N_WORKFLOW"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Stop the email automation" } },
      {
        name: "{{agent}}",
        content: { text: "Stopping the email workflow.", actions: ["DEACTIVATE_N8N_WORKFLOW"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Turn off workflow xyz789" } },
      {
        name: "{{agent}}",
        content: { text: "Deactivating workflow xyz789.", actions: ["DEACTIVATE_N8N_WORKFLOW"] },
      },
    ],
  ] as ActionExample[][],
};
