/**
 * DELETE_WORKFLOW action — removes an n8n workflow by id.
 *
 * Mirrors the AutomationsView handleDeleteWorkflow handler, which calls
 * DELETE /api/n8n/workflows/:id. Validates the workflow exists before
 * destructively deleting. Attached schedules are NOT cascaded by this action
 * — use DELETE_TRIGGER_TASK with cascade=true for that behavior.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { fetchJson, findWorkflowById, getApiBase } from "./api.js";

const DELETE_WORKFLOW_ACTION = "DELETE_WORKFLOW";

interface DeleteWorkflowParameters {
  workflowId?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const deleteWorkflowAction: Action = {
  name: DELETE_WORKFLOW_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "DELETE_N8N_WORKFLOW",
    "REMOVE_WORKFLOW",
    "DESTROY_WORKFLOW",
    "DELETE_AUTOMATION_WORKFLOW",
    "REMOVE_N8N_WORKFLOW",
  ],
  description:
    "Permanently delete an n8n workflow by id. Use when the user wants to remove a workflow entirely. Attached trigger schedules are not cascaded — handle those separately.",
  descriptionCompressed:
    "permanently delete n8n workflow id use user want remove workflow entirely attach trigger schedule cascad handle separately",
  validate: async () => true,
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const params = (options?.parameters ?? {}) as DeleteWorkflowParameters;
    const workflowId = readString(params.workflowId);
    if (!workflowId) {
      return { success: false, text: "workflowId parameter is required." };
    }

    const existing = await findWorkflowById(workflowId);
    if (!existing) {
      return { success: false, text: `Workflow not found: ${workflowId}` };
    }

    const base = getApiBase();
    const result = await fetchJson<{ ok?: boolean }>(
      `${base}/api/n8n/workflows/${encodeURIComponent(workflowId)}`,
      { method: "DELETE" },
    );
    if (!result.ok) {
      const errMsg =
        result.raw || `Failed to delete workflow (${result.status})`;
      logger.warn(`[delete-workflow] failed: ${errMsg}`);
      return { success: false, text: errMsg };
    }

    const successText = `Deleted workflow "${existing.name}".`;
    if (callback) {
      await callback({
        text: successText,
        action: DELETE_WORKFLOW_ACTION,
        metadata: { workflowId, workflowName: existing.name },
      });
    }
    return {
      success: true,
      text: successText,
      data: { workflowId, workflowName: existing.name },
    };
  },

  parameters: [
    {
      name: "workflowId",
      description: "ID of the n8n workflow to delete.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Delete the Linear close → Slack workflow." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Deleted workflow "Linear close → Slack post".',
          action: DELETE_WORKFLOW_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Remove that GitHub stars summary workflow." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Deleted workflow "GitHub stars morning summary".',
          action: DELETE_WORKFLOW_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};
