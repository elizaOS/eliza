/**
 * CHECK_CLOUD_CREDITS — Query ElizaCloud credit balance and usage.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudContainerService } from "../services/cloud-container";
import type {
  CreditBalanceResponse,
  CreditSummaryResponse,
} from "../types/cloud";

const DAILY_COST_PER_CONTAINER = 0.67;

export const checkCloudCreditsAction: Action = {
  name: "CHECK_CLOUD_CREDITS",
  description:
    "Check ElizaCloud credit balance, container costs, and estimated remaining runtime.",
  similes: [
    "check credits",
    "check balance",
    "how much credit",
    "cloud billing",
  ],
  tags: ["cloud", "billing"],
  parameters: [
    {
      name: "detailed",
      description: "Include transaction history",
      required: false,
      schema: { type: "boolean" },
    },
  ],

  async validate(runtime: IAgentRuntime): Promise<boolean> {
    return !!(
      runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined
    )?.isAuthenticated();
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> {
    const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService;
    const containerSvc = runtime.getService("CLOUD_CONTAINER") as
      | CloudContainerService
      | undefined;
    const client = auth.getClient();

    const detailed =
      options?.detailed === true ||
      (message.metadata as Record<string, unknown> | undefined)?.detailed ===
        true;

    const {
      data: { balance },
    } = await client.get<CreditBalanceResponse>("/credits/balance");

    const running =
      containerSvc?.getTrackedContainers().filter((c) => c.status === "running")
        .length ?? 0;
    const dailyCost = running * DAILY_COST_PER_CONTAINER;
    const daysRemaining = dailyCost > 0 ? balance / dailyCost : null;

    const lines = [
      `ElizaCloud credits: $${balance.toFixed(2)}`,
      running > 0
        ? `Active containers: ${running} ($${dailyCost.toFixed(2)}/day) — ~${daysRemaining?.toFixed(1)} days remaining`
        : "No active containers.",
    ];

    if (detailed) {
      const { data } =
        await client.get<CreditSummaryResponse>("/credits/summary");
      lines.push(
        `Total spent: $${data.totalSpent.toFixed(2)} | Total added: $${data.totalAdded.toFixed(2)}`,
      );
      for (const tx of data.recentTransactions.slice(0, 10)) {
        const sign = tx.amount >= 0 ? "+" : "";
        lines.push(
          `  ${sign}$${tx.amount.toFixed(2)} — ${tx.description} (${new Date(tx.created_at).toLocaleDateString()})`,
        );
      }
    }

    const text = lines.join("\n");
    if (callback) await callback({ text, actions: ["CHECK_CLOUD_CREDITS"] });

    return {
      success: true,
      text,
      data: {
        balance,
        runningContainers: running,
        dailyCost,
        estimatedDaysRemaining: daysRemaining,
      },
    };
  },
};
