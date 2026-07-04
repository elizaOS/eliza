import {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { KaminoService } from "../../services/kamino";

export const HealthAction: Action = {
  name: "KAMINO_HEALTH",
  similes: [
    "CHECK_POSITION",
    "POSITION_STATUS",
    "LIQUIDATION_RISK",
    "ACCOUNT_HEALTH",
    "MY_LOANS",
  ],
  description:
    "Check the health of your Kamino Lend positions across all markets. Shows deposits, borrows, health factor, borrow limit, and liquidation risk. Use when the user asks about their position, risk level, or wants a portfolio overview.",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    try {
      const service = runtime.getService<KaminoService>("kamino-service");
      if (!service?.isInitialized()) return false;
      return true;
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback,
  ) => {
    try {
      const service = runtime.getService<KaminoService>("kamino-service");
      const health = await service?.getHealthCheck(true);

      if (!health?.hasPositions) {
        await callback?.({
          text: "You have no active positions in Kamino lend.\n\n- To earn yield: use **KAMINO_LEND** to supply tokens\n- To borrow: use **KAMINO_DEPOSIT** to add collateral first",
          data: health,
        });
        return { success: true, text: "No active positions" };
      }
      const riskConfig: Record<string, { suggestion: string }> = {
        safe: { suggestion: "Your position is healthy. No action needed." },
        caution: {
          suggestion:
            "Consider reducing borrows or adding collateral to improve your safety buffer.",
        },
        danger: {
          suggestion:
            "Your position is at risk. Repay some debt or deposit collateral soon to avoid liquidation.",
        },
        critical: {
          suggestion:
            "URGENT: You are close to liquidation. Repay debt or add collateral immediately.",
        },
      };

      const risk = riskConfig[health.overallRisk] ?? riskConfig.critical;

      const lines: string[] = [
        `**Overall risk: ${health.overallRisk.toUpperCase()}**`,
        `Worst Health Factor: **${health.worstHealthFactor}** (below 1.0 = liquidatable)`,
        `${risk.suggestion}`,
        "",
      ];

      for (const pos of health.positions) {
        lines.push(`**${pos.marketName} Market**`);
        lines.push(
          `Health Factor: ${pos.healthFactor} | LTV: ${pos.ltv}% | Net value: $${pos.netValue}`,
        );
        lines.push(`Borrow limit: $${pos.borrowLimit}`);

        if (pos.deposits.length > 0) {
          lines.push("Deposits:");
          for (const d of pos.deposits) {
            lines.push(` ${d.amount} ${d.symbol} ($${d.valueUsd})`);
          }
        }

        if (pos.borrows.length > 0) {
          lines.push("Borrows:");
          for (const b of pos.borrows) {
            lines.push(`${b.amount} ${b.symbol} ($${b.valueUsd})`);
          }
        }

        lines.push("");
      }

      await callback?.({
        text: lines.join("\n").trim(),
        actions: ["KAMINO_HEALTH"],
        data: health,
      });
      return {
        success: true,
        text: `Position health : ${health?.overallRisk}`,
      };
    } catch (error: any) {
      await callback?.({
        text: `Failed to fetch position health: ${error.message ?? error}`,
        data: { error: String(error) },
      });
      return { success: false, text: String(error) };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "How is my position looking" } },
      {
        name: "{{agent}}",
        content: { text: "Overall Risk: SAFE...", actions: ["KAMINO_HEALTH"] },
      },
    ],
    [
      { name: "{{user}}", content: { text: "Am I at risk of liquidation" } },
      {
        name: "{{agent}}",
        content: {
          text: "Overall Risk: CRITICAL - You are close to liquidation",
          actions: ["KAMINO_HEALTH"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "Show me my loans" } },
      {
        name: "{{agent}}",
        content: {
          text: "Overall Risk: CAUTION...",
          actions: ["KAMINO_HEALTH"],
        },
      },
    ],
  ],
};
