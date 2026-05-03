import type { ActionResult, Evaluator, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { StewardService } from "../services/StewardService.js";

/**
 * Post-action evaluator for transactions awaiting manual approval.
 */
export const approvalRequiredEvaluator: Evaluator = {
  name: "approvalRequired",
  description: "Checks if the last transaction is pending manual approval and adjusts response",
  alwaysRun: false,
  examples: [],

  async validate(_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> {
    // Only run after Steward actions
    const action = (message.content as any)?.action;
    return typeof action === "string" && action.startsWith("STEWARD_");
  },

  async handler(
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
  ): Promise<ActionResult | undefined> {
    const steward = runtime.getService("steward" as any) as StewardService | null;
    if (!steward?.isConnected()) return undefined;

    // Check state for pending approval from the last action result
    const lastResult = (state as any)?.lastActionResult as ActionResult | undefined;
    if (lastResult?.data?.status !== "pending_approval") {
      return undefined;
    }

    // Log when a transaction is waiting on manual approval.
    console.info("[Steward] Transaction pending approval — user action required");

    return {
      success: true,
      text: "A transaction is awaiting your approval in the Steward dashboard.",
      data: {
        pendingApproval: true,
        policies: lastResult.data.policies,
      },
    };
  },
};
