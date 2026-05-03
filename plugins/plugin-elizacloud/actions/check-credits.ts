/**
 * CHECK_CLOUD_CREDITS — Query ElizaCloud credit balance and usage.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { CloudAuthService } from "../services/cloud-auth";
import type { CloudContainerService } from "../services/cloud-container";
import type { CreditBalanceResponse, CreditSummaryResponse } from "../types/cloud";

const DAILY_COST_PER_CONTAINER = 0.67;

export const checkCloudCreditsAction: Action = {
  name: "CHECK_CLOUD_CREDITS",
  description: "Check ElizaCloud credit balance, container costs, and estimated remaining runtime.",
  descriptionCompressed: "Check ElizaCloud credits, container costs, remaining runtime.",
  similes: ["check credits", "check balance", "how much credit", "cloud billing"],
  tags: ["cloud", "billing"],
  parameters: [
    {
      name: "detailed",
      description: "Include transaction history",
      required: false,
      schema: { type: "boolean" },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: HandlerOptions
  ): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["check", "cloud", "credits"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:check|cloud|credits)\b/i;
    const __avRegexOk = Boolean(__avText.match(__avRegex));
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (runtime: IAgentRuntime) => {
      return !!(
        runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined
      )?.isAuthenticated();
    };
    try {
      return Boolean(await __avLegacyValidate(runtime));
    } catch {
      return false;
    }
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    const auth = runtime.getService("CLOUD_AUTH") as CloudAuthService;
    const containerSvc = runtime.getService("CLOUD_CONTAINER") as CloudContainerService | undefined;
    const client = auth.getClient();

    const detailed =
      options?.detailed === true ||
      (message.metadata as Record<string, unknown> | undefined)?.detailed === true;

    const {
      data: { balance },
    } = await client.get<CreditBalanceResponse>("/credits/balance");

    const running =
      containerSvc?.getTrackedContainers().filter((c) => c.status === "running").length ?? 0;
    const dailyCost = running * DAILY_COST_PER_CONTAINER;
    const daysRemaining = dailyCost > 0 ? balance / dailyCost : null;

    const lines = [
      `ElizaCloud credits: $${balance.toFixed(2)}`,
      running > 0
        ? `Active containers: ${running} ($${dailyCost.toFixed(2)}/day) — ~${daysRemaining?.toFixed(1)} days remaining`
        : "No active containers.",
    ];

    if (detailed) {
      const { data } = await client.get<CreditSummaryResponse>("/credits/summary");
      lines.push(
        `Total spent: $${data.totalSpent.toFixed(2)} | Total added: $${data.totalAdded.toFixed(2)}`
      );
      for (const tx of data.recentTransactions.slice(0, 10)) {
        const sign = tx.amount >= 0 ? "+" : "";
        lines.push(
          `  ${sign}$${tx.amount.toFixed(2)} — ${tx.description} (${new Date(tx.created_at).toLocaleDateString()})`
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
