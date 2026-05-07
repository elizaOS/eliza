import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { addHeader, UUID } from "@elizaos/core";

/**
 * Current Run Context Provider
 *
 * Provides action execution results for the current agent run.
 * Formats action results in a readable format showing:
 * - Action name and execution status
 * - Plan steps (if available)
 * - Result text or error messages
 * - Reasoning behind action execution
 *
 * Only includes action results from the current run context.
 */
export const currentRunContextProvider: Provider = {
  name: "CURRENT_RUN_CONTEXT",
  description: "Action results and context for the current agent run",
  contexts: ["general", "media"],
  contextGate: { anyOf: ["general", "media"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "USER" },

  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const runId = runtime.getCurrentRunId();
    const actionsResults = runtime.getActionResults(message.id as UUID);

    // If no run or no action results, return empty
    if (!runId || !actionsResults || actionsResults.length === 0) {
      return {
        values: {
          currentRunActionResults: "",
        },
        data: {
          runId,
          actionCount: 0,
          actions: [],
        },
        text: "",
      };
    }

    // Format action results similar to short-term-memory provider
    const formattedActions = actionsResults
      .map((result) => {
        const actionName = result.data?.actionName || "Unknown Action";
        const success = result.success ? "success" : "failed";
        const reasoning = result.data?.reasoning || "";
        const text = result.text || "";
        const error = result.data?.error || "";

        // Build the action result text
        let actionText = `  - **${actionName}** (${success})`;

        // Add reasoning if available
        if (reasoning) {
          actionText += `\n    Reasoning: ${reasoning}`;
        }

        // Add error or result text
        if (error) {
          actionText += `\n    Error: ${error}`;
        } else if (text) {
          actionText += `\n    Result: ${text}`;
        }

        return actionText;
      })
      .join("\n\n");

    const runIdShort = String(runId).slice(0, 8);
    const headerText = `**Current Run** (ID: ${runIdShort})\n\n${formattedActions}`;

    const currentRunActionResults = addHeader("# Current Run Action Results", headerText);

    return {
      values: {
        currentRunActionResults,
      },
      data: {
        runId,
        actionCount: actionsResults.length,
        actions: actionsResults.map((r) => ({
          name: r.data?.actionName,
          success: r.success,
          hasReasoning: !!r.data?.reasoning,
          hasError: !!r.data?.error,
        })),
      },
      text: currentRunActionResults,
    };
  },
};
