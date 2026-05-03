import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { StewardService } from "../services/StewardService.js";

/**
 * STEWARD_CHECK_SPEND — query the agent's spending stats via the dashboard endpoint.
 *
 * Returns today/week/month spend in a human-readable format.
 */
export const checkSpendAction: Action = {
  name: "STEWARD_CHECK_SPEND",
  description: "Check the agent wallet's spending stats (today, this week, this month)",
  similes: [
    "check spend",
    "how much have I spent",
    "spending stats",
    "spend summary",
    "budget check",
  ],

  parameters: [],

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "How much has the agent spent today?",
          action: "STEWARD_CHECK_SPEND",
        },
      },
    ],
  ] as ActionExample[][],

  async validate(runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> {
    const steward = runtime.getService("steward" as any) as StewardService | null;
    return steward?.isConnected() ?? false;
  },

  async handler(
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: HandlerOptions,
  ): Promise<ActionResult> {
    const steward = runtime.getService("steward" as any) as StewardService;

    try {
      const dashboard = await steward.getDashboard();

      const { spend } = dashboard;

      return {
        success: true,
        text: [
          `📊 **Spending Summary**`,
          `• Today: ${spend.todayFormatted} ETH`,
          `• This week: ${spend.thisWeekFormatted} ETH`,
          `• This month: ${spend.thisMonthFormatted} ETH`,
          `• Pending approvals: ${dashboard.pendingApprovals}`,
        ].join("\n"),
        data: { spend, pendingApprovals: dashboard.pendingApprovals },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: msg,
        text: `Could not retrieve spending stats: ${msg}`,
      };
    }
  },
};
