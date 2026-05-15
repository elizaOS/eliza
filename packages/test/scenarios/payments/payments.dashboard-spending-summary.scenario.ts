import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

/**
 * Closes the gap from the lifeops audit (`docs/audits/lifeops-2026-05-09/
 * 03-coverage-gap-matrix.md` line 444 + #67): `paymentsAction` had no scenario.
 *
 * The companion `payments.agent-charge-five-dollar.scenario.ts` covers the
 * Cloud-app charge surface (`CREATE_APP_CHARGE`); this scenario covers the
 * lifeops `PAYMENTS` umbrella's dashboard read path. Owner asks "how am I
 * spending" → planner should route to PAYMENTS with mode=dashboard or
 * spending_summary, and the result data must contain the composite
 * dashboard payload (sources + spending + recurring) so the agent has the
 * facts it needs to summarize.
 */
export default scenario({
  id: "payments.dashboard-spending-summary",
  title: "User asks for a spending summary → PAYMENTS returns the dashboard",
  domain: "payments",
  tags: ["payments", "dashboard", "spending", "lifeops"],
  description:
    "When the owner asks how their money is being spent, the planner should call PAYMENTS in dashboard mode (or spending_summary) and the result data must carry the structured payments dashboard.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
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
        acceptedActions: ["PAYMENTS"],
        description: "payments dashboard / spending summary",
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
      actionName: "PAYMENTS",
    },
    {
      type: "custom",
      name: "payments-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["PAYMENTS"],
        description: "PAYMENTS umbrella invoked",
      }),
    },
    {
      type: "custom",
      name: "payments-result-shape",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "PAYMENTS",
        );
        if (!hit) return "expected PAYMENTS action result";
        const data = hit.result?.data as
          | {
              dashboard?: {
                sources?: unknown[];
                spending?: { transactionCount?: number };
              };
              summary?: { transactionCount?: number };
            }
          | undefined;
        // Dashboard mode → dashboard.* present.
        // spending_summary mode → summary.* present.
        // Either is acceptable; both must report transactionCount.
        const dashCount = data?.dashboard?.spending?.transactionCount;
        const summaryCount = data?.summary?.transactionCount;
        if (typeof dashCount !== "number" && typeof summaryCount !== "number") {
          return "expected PAYMENTS to return dashboard.spending.transactionCount or summary.transactionCount";
        }
        return undefined;
      },
    },
  ],
});
