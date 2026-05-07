/**
 * TOGGLE_WORKFLOW_ACTIVE action — activates or deactivates an n8n workflow.
 *
 * Mirrors AutomationsView.handleToggleWorkflowActive, which calls
 * POST /api/n8n/workflows/:id/activate or .../deactivate based on desired
 * state.
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
import { hasOwnerAccess } from "../../security/access.js";
import {
  fetchJson,
  findWorkflowById,
  getApiBase,
  type N8nWorkflowResponse,
} from "./api.js";

const TOGGLE_WORKFLOW_ACTIVE_ACTION = "TOGGLE_WORKFLOW_ACTIVE";

interface ToggleWorkflowParameters {
  workflowId?: unknown;
  active?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return undefined;
}

export const toggleWorkflowActiveAction: Action = {
  name: TOGGLE_WORKFLOW_ACTIVE_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "ACTIVATE_WORKFLOW",
    "DEACTIVATE_WORKFLOW",
    "ENABLE_WORKFLOW",
    "DISABLE_WORKFLOW",
    "PAUSE_WORKFLOW",
    "RESUME_WORKFLOW",
    "ACTIVATE_N8N_WORKFLOW",
    "DEACTIVATE_N8N_WORKFLOW",
  ],
  description:
    "Activate or deactivate an n8n workflow by id. Set active=true to enable, active=false to pause it without deleting.",
  descriptionCompressed:
    "activate deactivate n8n workflow id set active true enable, active false pause wo/ delet",
  validate: async (runtime, message) => hasOwnerAccess(runtime, message),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        success: false,
        text: "Permission denied: only the owner may toggle workflows.",
      };
    }

    const params = (options?.parameters ?? {}) as ToggleWorkflowParameters;
    const workflowId = readString(params.workflowId);
    const active = readBoolean(params.active);
    if (!workflowId) {
      return { success: false, text: "workflowId parameter is required." };
    }
    if (active === undefined) {
      return {
        success: false,
        text: "active parameter is required (true or false).",
      };
    }

    const existing = await findWorkflowById(workflowId);
    if (!existing) {
      return { success: false, text: `Workflow not found: ${workflowId}` };
    }

    const base = getApiBase();
    const verb = active ? "activate" : "deactivate";
    const result = await fetchJson<N8nWorkflowResponse>(
      `${base}/api/n8n/workflows/${encodeURIComponent(workflowId)}/${verb}`,
      { method: "POST" },
    );
    if (!result.ok || !result.data) {
      const errMsg =
        result.raw || `Failed to ${verb} workflow (${result.status})`;
      logger.warn(`[toggle-workflow-active] failed: ${errMsg}`);
      return { success: false, text: errMsg };
    }

    const workflow = result.data;
    const successText = active
      ? `Activated workflow "${workflow.name}".`
      : `Deactivated workflow "${workflow.name}".`;
    if (callback) {
      await callback({
        text: successText,
        action: TOGGLE_WORKFLOW_ACTIVE_ACTION,
        metadata: { workflowId, active },
      });
    }
    return {
      success: true,
      text: successText,
      values: { workflowId, active },
      data: { workflow },
    };
  },

  parameters: [
    {
      name: "workflowId",
      description: "ID of the n8n workflow to toggle.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "active",
      description: "Target state: true to activate, false to deactivate.",
      required: true,
      schema: { type: "boolean" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Activate the GitHub stars workflow." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Activated workflow "GitHub stars morning summary".',
          action: TOGGLE_WORKFLOW_ACTIVE_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Pause the Linear → Slack workflow for now." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Deactivated workflow "Linear close → Slack post".',
          action: TOGGLE_WORKFLOW_ACTIVE_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};
