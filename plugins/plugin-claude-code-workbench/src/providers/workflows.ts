import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { ClaudeCodeWorkbenchService } from "../services/workbench-service.ts";
const WORKFLOW_LIMIT = 20;
const DESCRIPTION_LIMIT = 160;

/**
 * Provider that surfaces the allowlisted Claude Code workbench workflows as
 * a JSON table. Replaces the legacy `CLAUDE_CODE_WORKBENCH_LIST`
 * action — listing capabilities is read-only context for the planner, not a
 * mutating action that needs its own dispatch.
 */
export const claudeCodeWorkbenchWorkflowsProvider: Provider = {
  name: "workbenchWorkflows",
  description:
    "Lists allowlisted Claude Code workbench workflows the agent can run via CLAUDE_CODE_WORKBENCH_RUN.",
  contexts: ["code", "automation", "agent_internal"],
  contextGate: { anyOf: ["code", "automation", "agent_internal"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
  ): Promise<ProviderResult> => {
    const service = runtime.getService(
      "claude_code_workbench",
    ) as ClaudeCodeWorkbenchService | null;

    if (!service) {
      return {
        text: JSON.stringify({ workbenchWorkflows: [] }, null, 2),
        values: { workbenchWorkflowsAvailable: false },
        data: { available: false, workflows: [] },
      };
    }

    try {
      const workflows = service.listWorkflows();
      const rows = workflows.slice(0, WORKFLOW_LIMIT).map((workflow) => ({
        id: workflow.id,
        enabled: workflow.enabled,
        mutatesRepo: workflow.mutatesRepo,
        category: workflow.category,
        description: workflow.description.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT),
      }));

      return {
        text: JSON.stringify({ workbenchWorkflows: rows }, null, 2),
        values: { workbenchWorkflowsAvailable: true },
        data: { available: true, workflows: rows },
      };
    } catch (error) {
      return {
        text: JSON.stringify({ workbenchWorkflows: [], status: "error" }, null, 2),
        values: { workbenchWorkflowsAvailable: false },
        data: {
          available: false,
          workflows: [],
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};
