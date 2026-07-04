/** Corpus guard for the executive-assistant LifeOps scenarios: loads every `.scenario.ts` under packages/test/scenarios/lifeops.executive-assistant and asserts the expected scenario-id set is present and well-formed (no live model). */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const executiveScenarioDir = resolve(
  repoRoot,
  "packages/test/scenarios/lifeops.executive-assistant",
);

const EXPECTED_EXECUTIVE_SCENARIO_IDS = [
  "executive.approval-batch-safe-actions",
  "executive.board-pack-prep",
  "executive.chief-of-staff-handoff",
  "executive.command-brief-risk-triage",
  "executive.delegation-map",
  "executive.document-signature-review",
  "executive.end-of-day-closeout",
  "executive.event-planning",
  "executive.expense-capture",
  "executive.family-logistics",
  "executive.finance-dispute",
  "executive.gift-milestone",
  "executive.hiring-loop",
  "executive.home-ops",
  "executive.interruption-firebreak",
  "executive.intro-routing",
  "executive.legal-deadline",
  "executive.meeting-prep-docs-people",
  "executive.outage-recovery",
  "executive.people-cadence",
  "executive.privacy-redaction",
  "executive.remote-agent-stuck",
  "executive.renewals-keep-cancel",
  "executive.status-compression",
  "executive.travel-disruption",
  "executive.travel-readiness",
  "executive.vendor-negotiation",
  "executive.vip-escalation",
  "executive.waiting-on-cross-channel",
  "executive.weekly-operating-review",
] as const;

type ScenarioShape = {
  id?: string;
  domain?: string;
  tags?: string[];
  turns?: Array<Record<string, unknown>>;
  finalChecks?: Array<Record<string, unknown>>;
};

async function loadExecutiveScenarios(): Promise<ScenarioShape[]> {
  const files = readdirSync(executiveScenarioDir)
    .filter((file) => file.endsWith(".scenario.ts"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const mod = (await import(
        pathToFileURL(resolve(executiveScenarioDir, file)).href
      )) as { default?: ScenarioShape };
      return mod.default ?? {};
    }),
  );
}

describe("LifeOps executive assistant scenarios", () => {
  it("covers the assistant command surface with durable scenario files", async () => {
    const scenarios = await loadExecutiveScenarios();
    const ids = scenarios.map((scenario) => scenario.id).sort();

    expect(ids).toEqual([...EXPECTED_EXECUTIVE_SCENARIO_IDS].sort());
    expect(new Set(ids).size).toBe(EXPECTED_EXECUTIVE_SCENARIO_IDS.length);
  });

  it("keeps every executive scenario chat-first and evaluation-backed", async () => {
    const scenarios = await loadExecutiveScenarios();

    for (const scenario of scenarios) {
      expect(scenario.domain).toBe("lifeops.executive-assistant");
      expect(scenario.tags).toContain("lifeops");
      expect(scenario.tags).toContain("executive-assistant");
      expect(scenario.turns?.length ?? 0).toBeGreaterThan(0);

      const userText = scenario.turns
        ?.map((turn) => String(turn.text ?? ""))
        .join("\n");
      expect(userText).toMatch(
        /brief|prep|waiting|travel|expense|renewal|relationship|doc|home|closeout|approval|delegat|family|interrupt|outage|privacy|remote|status|vip|weekly|board|handoff|event|dispute|gift|hiring|intro|legal|vendor/i,
      );

      const hasActionCheck = scenario.finalChecks?.some(
        (check) => check.type === "selectedAction" || check.type === "custom",
      );
      const hasRubric = scenario.finalChecks?.some(
        (check) =>
          check.type === "judgeRubric" ||
          (typeof check.name === "string" && check.name.includes("rubric")),
      );
      expect(hasActionCheck).toBe(true);
      expect(hasRubric).toBe(true);
    }
  });
});
