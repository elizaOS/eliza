import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderDataRecord,
  type ProviderValue,
  type State,
} from "@elizaos/core";
import { N8N_WORKFLOW_SERVICE_TYPE, type N8nWorkflowService } from "../services/index";
import type { WorkflowDraft } from "../types/index";

const DRAFT_TTL_MS = 30 * 60 * 1000;

/**
 * Unified n8n Workflows Provider.
 *
 * Merges the old activeWorkflowsProvider, workflowStatusProvider, and pendingDraftProvider
 * into a single provider that:
 *   1. Lists the user's workflows (no N+1 execution queries)
 *   2. Shows pending draft status with LLM routing instructions
 *   3. Provides action routing guidance
 *
 * This runs on every message so the LLM has context about available workflows
 * and any pending draft that needs attention.
 */
export const n8nWorkflowsProvider: Provider = {
  name: "n8n_workflows",
  description: "User's n8n workflows and pending draft status with action routing guidance",

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const sections: string[] = [];
    const data: ProviderDataRecord = {};
    const values: Record<string, ProviderValue> = {};

    // --- Pending Draft ---
    try {
      const cacheKey = `workflow_draft:${message.entityId}`;
      const draft = await runtime.getCache<WorkflowDraft>(cacheKey);

      if (draft && Date.now() - draft.createdAt <= DRAFT_TTL_MS) {
        const nodeNames = draft.workflow.nodes.map((n) => n.name).join(" -> ");

        sections.push(
          `## Pending Workflow Draft\n\n` +
            `A workflow draft "${draft.workflow.name}" is awaiting user action.\n` +
            `Nodes: ${nodeNames}\n\n` +
            `**REQUIRED**: Any user message about this draft MUST trigger CREATE_N8N_WORKFLOW.\n` +
            `This includes confirmations ("yes", "ok", "deploy"), cancellations ("cancel", "nevermind"),\n` +
            `and modifications ("change X", "use Y instead"). Do NOT handle via text reply.`
        );

        data.hasPendingDraft = true;
        data.draftName = draft.workflow.name;
        values.hasPendingDraft = true;
      }
    } catch (error) {
      logger.debug(
        { src: "plugin:n8n:provider:workflows" },
        `Draft check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // --- Workflow List ---
    try {
      const service = await runtime.getService<N8nWorkflowService>(N8N_WORKFLOW_SERVICE_TYPE);

      if (service) {
        const userId = message.entityId;
        const workflows = await service.listWorkflows(userId);

        if (workflows.length > 0) {
          const workflowList = workflows
            .slice(0, 20)
            .map((wf) => {
              const status = wf.active ? "Active" : "Inactive";
              const nodeCount = wf.nodes?.length || 0;
              return `- "${wf.name}" (ID: ${wf.id}, ${status}, ${nodeCount} nodes)`;
            })
            .join("\n");

          sections.push(
            `## Available Workflows (${workflows.length})\n\n` +
              `${workflowList}\n\n` +
              `Actions: ACTIVATE/DEACTIVATE/DELETE_N8N_WORKFLOW to manage, GET_N8N_EXECUTIONS for run history.`
          );

          data.workflows = workflows.map((wf) => ({
            id: wf.id,
            name: wf.name,
            active: wf.active || false,
            nodeCount: wf.nodes?.length || 0,
          }));
          values.hasWorkflows = true;
          values.workflowCount = workflows.length;
        }
      }
    } catch (error) {
      logger.error(
        { src: "plugin:n8n:provider:workflows" },
        `Failed to list workflows: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (sections.length === 0) {
      return { text: "", data: {}, values: {} };
    }

    return {
      text: `# n8n Workflows\n\n${sections.join("\n\n")}`,
      data,
      values,
    };
  },
};
