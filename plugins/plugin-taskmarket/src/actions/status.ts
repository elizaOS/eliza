/**
 * TASKMARKET_STATUS — read-only account view: wallet balance, agent reputation,
 * and the caller's own submissions with their current state.
 *
 * This is the "did the delegated work land?" surface. It moves no money and
 * exposes no settlement lever: accepting a submission and releasing escrow stay
 * with the human on taskmarket.dev, deliberately outside this plugin.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
  State,
} from "@elizaos/core";
import {
  getAgentStats,
  getWalletBalance,
  listMySubmissions,
  TaskMarketApiError,
  TaskMarketResponseError,
} from "../lib/client.ts";
import {
  failureActionResult,
  formatUsdc,
  readStringParam,
  resolveTaskMarketConfig,
  successActionResult,
  TASKMARKET_CONTEXTS,
} from "../types.ts";

const MAX_SUBMISSIONS_SHOWN = 15;

export const taskMarketStatusAction: Action = {
  name: "TASKMARKET_STATUS",
  contexts: [...TASKMARKET_CONTEXTS],
  similes: [
    "TASKMARKET_BALANCE",
    "TASKMARKET_SUBMISSIONS",
    "CHECK_TASKMARKET_ACCOUNT",
  ],
  description:
    "Report TaskMarket account state: USDC wallet balance on Base, agent reputation stats, and the caller's own submissions. Read-only — it cannot accept work, release escrow, or withdraw funds.",
  parameters: [
    {
      name: "subaction",
      description:
        "'all' (default), 'balance' for wallet + reputation only, or 'submissions' for own submissions only.",
      required: false,
      schema: {
        type: "string",
        enum: ["all", "balance", "submissions"],
        default: "all",
      },
    },
  ],
  validate: async (runtime: IAgentRuntime) =>
    resolveTaskMarketConfig(runtime) !== undefined,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const config = resolveTaskMarketConfig(runtime);
    if (!config) {
      return failureActionResult({
        reason: "not_configured",
        message:
          "TASKMARKET_API_TOKEN and TASKMARKET_ADDRESS must both be set (the API bearer token does not identify the caller).",
      });
    }

    const subaction = (
      readStringParam(options, "subaction") ?? "all"
    ).toLowerCase();
    const wantBalance = subaction === "all" || subaction === "balance";
    const wantSubmissions = subaction === "all" || subaction === "submissions";

    try {
      const lines: string[] = [];
      const data: ProviderDataRecord = { action: "TASKMARKET_STATUS" };

      if (wantBalance) {
        const [balance, stats] = await Promise.all([
          getWalletBalance(config),
          getAgentStats(config),
        ]);
        lines.push(
          `Balance: ${balance} USDC on Base`,
          `Agent ${stats.agentId ?? "?"} | completed ${stats.completedTasks ?? 0} | rated ${stats.ratedTasks ?? 0} | avg rating ${stats.averageRating ?? "n/a"} | credibility ${stats.credibility ?? "n/a"}`,
          `Total earnings: ${formatUsdc(stats.totalEarnings)}`,
        );
        data.balanceUsdc = balance;
        data.agentId = stats.agentId;
      }

      if (wantSubmissions) {
        const submissions = await listMySubmissions(config);
        data.submissionCount = submissions.length;
        if (submissions.length === 0) {
          lines.push("No submissions yet.");
        } else {
          const shown = [...submissions]
            .sort((a, b) =>
              (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""),
            )
            .slice(-MAX_SUBMISSIONS_SHOWN);
          lines.push(
            `Submissions: ${submissions.length} total, showing ${shown.length} most recent:`,
            ...shown.map((submission) => {
              const outcome = submission.rejectedAt
                ? "rejected"
                : (submission.taskStatus ?? "unknown");
              return `- task ${submission.taskId ?? "?"} | ${formatUsdc(submission.taskReward)} ${submission.taskMode ?? "?"} | task ${outcome} | submitted ${submission.submittedAt ?? "?"}`;
            }),
          );
        }
      }

      return successActionResult(lines.join("\n"), data);
    } catch (error) {
      if (error instanceof TaskMarketApiError) {
        return failureActionResult(
          {
            reason: "api_error",
            message: `HTTP ${error.status}: ${error.message}`,
          },
          { action: "TASKMARKET_STATUS" },
        );
      }
      if (error instanceof TaskMarketResponseError) {
        return failureActionResult(
          { reason: "invalid_response", message: error.message },
          { action: "TASKMARKET_STATUS" },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return failureActionResult(
        { reason: "io_error", message },
        { action: "TASKMARKET_STATUS" },
      );
    }
  },
};
