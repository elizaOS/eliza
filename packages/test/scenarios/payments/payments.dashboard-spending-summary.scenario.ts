/** Proves live-model routing to the current owner-finances spending-summary contract. */

import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * This scenario tests model selection and exact arguments. The payment service's
 * real persistence contract is covered by its owning plugin integration tests.
 */
export default scenario({
  lane: "live-only",
  executionProfile: "simulated",
  evidenceScope: "model-behavior",
  id: "payments.dashboard-spending-summary",
  title: "Spending request routes to OWNER_FINANCES for exactly 30 days",
  domain: "payments",
  tags: ["payments", "dashboard", "spending", "lifeops"],
  description:
    "When the owner asks about the last 30 days of spending, the live planner must call OWNER_FINANCES with action=spending_summary and windowDays=30, and the action must return a matching structured summary.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-personal-assistant"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Payments Dashboard",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-spending-summary",
      room: "main",
      text: "What does my spending look like over the last 30 days? Pull my payments dashboard.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["OWNER_FINANCES"],
        description: "30-day owner-finances spending summary",
      }),
      responseIncludesAny: [
        "spend",
        "payment",
        "transactions",
        "dashboard",
        "recurring",
      ],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "OWNER_FINANCES",
    },
    {
      type: "selectedActionArguments",
      actionName: "OWNER_FINANCES",
      includesAll: [
        /"action"\s*:\s*"spending_summary"/,
        /"windowDays"\s*:\s*30/,
      ],
    },
    {
      type: "custom",
      name: "payments-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["OWNER_FINANCES"],
        description: "OWNER_FINANCES umbrella invoked",
      }),
    },
    {
      type: "custom",
      name: "payments-result-shape",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "OWNER_FINANCES",
        );
        if (!hit) return "expected OWNER_FINANCES action result";
        const data = hit.result?.data as
          | {
              summary?: {
                transactionCount?: number;
                totalSpendUsd?: number;
                windowDays?: number;
              };
            }
          | undefined;
        if (data?.summary?.windowDays !== 30) {
          return `expected summary.windowDays=30, saw ${String(data?.summary?.windowDays)}`;
        }
        if (
          typeof data.summary.transactionCount !== "number" ||
          typeof data.summary.totalSpendUsd !== "number"
        ) {
          return "expected OWNER_FINANCES to return numeric summary transactionCount and totalSpendUsd";
        }
        return undefined;
      },
    },
  ],
});
