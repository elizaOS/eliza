import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import type { ClaudeCodeWorkbenchService } from "../services/workbench-service.ts";

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

    const workflows = service.listWorkflows();
    const rows = workflows.map((workflow) => ({
      id: workflow.id,
      enabled: workflow.enabled,
      mutatesRepo: workflow.mutatesRepo,
      category: workflow.category,
      description: workflow.description.replace(/\s+/g, " ").trim(),
    }));

    return {
      text: JSON.stringify({ workbenchWorkflows: rows }, null, 2),
      values: { workbenchWorkflowsAvailable: true },
      data: { available: true, workflows },
    };
  },
};
