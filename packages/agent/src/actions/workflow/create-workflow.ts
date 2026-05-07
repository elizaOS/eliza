/**
 * CREATE_WORKFLOW action — generates a new n8n workflow from a seed prompt.
 *
 * Mirrors the AutomationsView createWorkflowDraft / generateWorkflowFromPrompt
 * path, which calls POST /api/n8n/workflows/generate with `{ prompt, name? }`.
 * Without a seedPrompt the UI only opens a local draft conversation and never
 * materializes a workflow on the n8n side, so this action requires a prompt.
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
import { fetchJson, getApiBase, type N8nWorkflowResponse } from "./api.js";

const CREATE_WORKFLOW_ACTION = "CREATE_WORKFLOW";

interface CreateWorkflowParameters {
  seedPrompt?: unknown;
  name?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const createWorkflowAction: Action = {
  name: CREATE_WORKFLOW_ACTION,
  contexts: ["automation", "tasks", "agent_internal"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "GENERATE_WORKFLOW",
    "CREATE_N8N_WORKFLOW",
    "CREATE_AUTOMATION_WORKFLOW",
    "MAKE_WORKFLOW",
    "BUILD_WORKFLOW",
    "DRAFT_WORKFLOW",
    "GENERATE_N8N_WORKFLOW",
  ],
  description:
    "Generate a new n8n workflow from a seed prompt describing the desired multi-step pipeline. Requires a seedPrompt — without one the UI only opens a local draft and never creates a real workflow.",
  descriptionCompressed:
    "generate new n8n workflow seed prompt describ desir multi-step pipeline require seedprompt wo/ one UI open local draft never create real workflow",
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
        text: "Permission denied: only the owner may create workflows.",
      };
    }

    const params = (options?.parameters ?? {}) as CreateWorkflowParameters;
    const seedPrompt = readString(params.seedPrompt);
    const name = readString(params.name);
    if (!seedPrompt) {
      return {
        success: false,
        text: "seedPrompt parameter is required to generate a workflow.",
      };
    }

    const base = getApiBase();
    const result = await fetchJson<N8nWorkflowResponse>(
      `${base}/api/n8n/workflows/generate`,
      {
        method: "POST",
        body: JSON.stringify({
          prompt: seedPrompt,
          ...(name ? { name } : {}),
        }),
      },
    );

    if (!result.ok || !result.data?.id) {
      const errMsg =
        result.raw || `Failed to generate workflow (${result.status})`;
      logger.warn(`[create-workflow] failed: ${errMsg}`);
      return { success: false, text: errMsg };
    }

    const workflow = result.data;
    const successText = `Created workflow "${workflow.name}".`;
    if (callback) {
      await callback({
        text: successText,
        action: CREATE_WORKFLOW_ACTION,
        metadata: { workflowId: workflow.id, workflowName: workflow.name },
      });
    }
    return {
      success: true,
      text: successText,
      values: { workflowId: workflow.id, workflowName: workflow.name },
      data: { workflow },
    };
  },

  parameters: [
    {
      name: "seedPrompt",
      description:
        "Natural-language description of the workflow: trigger, steps, integrations, and outputs.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "name",
      description: "Optional explicit name for the new workflow.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Build a workflow that posts to Slack when a Linear issue closes.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created workflow "Linear close → Slack post".',
          action: CREATE_WORKFLOW_ACTION,
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Generate an n8n workflow that emails me a summary of new GitHub stars every morning.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created workflow "GitHub stars morning summary".',
          action: CREATE_WORKFLOW_ACTION,
        },
      },
    ],
  ] as ActionExample[][],
};
