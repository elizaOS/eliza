import type { Action, ActionExample } from "@elizaos/core";
import { executeWorkflowAction, validateWorkflowService } from "./workflowActionHelper";

export const getExecutionsAction: Action = {
  name: "GET_N8N_EXECUTIONS",
  similes: [
    "GET_EXECUTIONS",
    "SHOW_EXECUTIONS",
    "EXECUTION_HISTORY",
    "WORKFLOW_RUNS",
    "WORKFLOW_HISTORY",
    "CHECK_WORKFLOW_RUNS",
  ],
  description:
    "Show execution history for an n8n workflow including run status, timestamps, and error messages. " +
    "Use this when the user asks about recent runs, execution history, or whether a workflow ran successfully. " +
    "Do NOT use this for plugin creation status — use CHECK_PLUGIN_STATUS instead.",

  validate: async (runtime) => validateWorkflowService(runtime),

  handler: async (runtime, message, state, _options, callback) =>
    executeWorkflowAction({
      runtime,
      message,
      state,
      callback,
      actionLabel: "get-executions",
      noWorkflowsMessage: "No workflows available to check executions for.",
      execute: async (service, workflowId) => {
        const executions = await service.getWorkflowExecutions(workflowId, 10);

        if (executions.length === 0) {
          return `No executions found for this workflow. It may not have run yet.`;
        }

        let text = `Execution History (Last ${executions.length} runs)\n\n`;

        for (const execution of executions) {
          const statusEmoji =
            execution.status === "success"
              ? "OK"
              : execution.status === "error"
                ? "FAILED"
                : execution.status === "running"
                  ? "RUNNING"
                  : "UNKNOWN";

          text += `[${statusEmoji}] ${execution.status.toUpperCase()}\n`;
          text += `   Execution ID: ${execution.id}\n`;
          text += `   Started: ${new Date(execution.startedAt).toLocaleString()}\n`;

          if (execution.stoppedAt) {
            text += `   Finished: ${new Date(execution.stoppedAt).toLocaleString()}\n`;
          }

          if (execution.data?.resultData?.error) {
            text += `   Error: ${execution.data.resultData.error.message}\n`;
          }

          text += "\n";
        }

        return text;
      },
    }),

  examples: [
    [
      { name: "{{user1}}", content: { text: "Show me the execution history for the Stripe workflow" } },
      {
        name: "{{agent}}",
        content: { text: "I'll fetch the execution history for that workflow.", actions: ["GET_N8N_EXECUTIONS"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "How did the email automation run last time?" } },
      {
        name: "{{agent}}",
        content: { text: "Let me check the recent runs for that workflow.", actions: ["GET_N8N_EXECUTIONS"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Did the payment workflow succeed?" } },
      {
        name: "{{agent}}",
        content: { text: "I'll check the latest execution status.", actions: ["GET_N8N_EXECUTIONS"] },
      },
    ],
  ] as ActionExample[][],
};
