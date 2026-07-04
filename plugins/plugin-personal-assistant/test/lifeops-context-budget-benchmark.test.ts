/**
 * Exercises the LifeOps context-budget benchmark: per-provider token payloads, ablation
 * deltas, and over-budget flagging. Deterministic fixture payloads.
 */
import { describe, expect, it } from "vitest";
import {
  buildLifeOpsContextBudgetReport,
  LIFEOPS_CONTEXT_PROVIDER_IDS,
  type LifeOpsContextBudgetScenario,
} from "./helpers/lifeops-context-budget-benchmark.js";

const SCENARIOS: LifeOpsContextBudgetScenario[] = [
  {
    id: "morning-brief",
    tokenBudget: 240,
    requiredProviders: ["lifeops", "inboxTriage", "health"],
    providerPayloads: {
      lifeops:
        "calendar: board call at 9, dentist at 15:00; tasks: review deck",
      inboxTriage: "urgent: CFO asks for runway numbers before noon",
      health: "sleep recap: 6h 20m, wake drift +35m",
      roomPolicy: "owner room, approvals required before external sends",
    },
  },
  {
    id: "work-thread-handoff",
    tokenBudget: 220,
    requiredProviders: ["workThreads", "pendingPrompts", "crossChannelContext"],
    providerPayloads: {
      workThreads: "thread launch-plan: waiting on design review and QA owner",
      pendingPrompts: "task st_123 asks whether to send the partner update",
      crossChannelContext:
        "telegram Sam asked for the latest launch ETA; email has draft",
      recentTaskStates: "last reminder delivered; no overdue escalations",
      firstRun: "onboarding complete",
    },
  },
];

describe("LifeOps context budget benchmark", () => {
  it("reports per-provider token payload and ablation deltas", () => {
    const report = buildLifeOpsContextBudgetReport(SCENARIOS);

    expect(report.scenarios).toHaveLength(2);
    for (const scenario of report.scenarios) {
      expect(scenario.totalTokens).toBeLessThanOrEqual(scenario.tokenBudget);
      expect(scenario.overBudget).toBe(false);
      expect(scenario.providers).toHaveLength(
        LIFEOPS_CONTEXT_PROVIDER_IDS.length,
      );
    }

    const morning = report.scenarios.find(
      (scenario) => scenario.scenarioId === "morning-brief",
    );
    expect(
      morning?.providers.find((metric) => metric.providerId === "health")
        ?.ablationDelta,
    ).toBe(1);
    expect(
      morning?.providers.find((metric) => metric.providerId === "firstRun")
        ?.ablationDelta,
    ).toBe(0);
    expect(report.providerTotals.lifeops).toBeGreaterThan(0);
  });

  it("marks over-budget context with trajectory_token_budget", () => {
    const report = buildLifeOpsContextBudgetReport([
      {
        id: "over-budget",
        tokenBudget: 1,
        requiredProviders: ["lifeops"],
        providerPayloads: {
          lifeops: "this payload is intentionally too large for the budget",
        },
      },
    ]);

    expect(report.scenarios[0]?.overBudget).toBe(true);
    expect(report.scenarios[0]?.overBudgetKind).toBe("trajectory_token_budget");
  });
});
