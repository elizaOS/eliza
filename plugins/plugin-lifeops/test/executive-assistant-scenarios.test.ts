import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, "scenarios");

const requiredScenarioIds = [
  "bill-approval-and-payment",
  "daily-brief-cross-channel",
  "delegation-map-status-compression",
  "document-signature-chase",
  "draft-approval-sweep",
  "family-work-conflict-repair",
  "group-chat-handoff-proposal",
  "hiring-loop-candidate-coordination",
  "home-repair-contractor-coordination",
  "insurance-claim-paperwork",
  "investor-update-digest",
  "legal-deadline-redline",
  "missed-call-repair-reschedule",
  "passport-renewal-travel-readiness",
  "priority-triage-mixed-sources",
  "privacy-redaction-forward",
  "school-family-calendar-carpool",
  "subscription-cancel-save",
  "tax-deadline-prep",
  "travel-blackout-bulk-reschedule",
  "travel-disruption-decision-tree",
  "vendor-negotiation-approval",
  "vip-escalation-firebreak",
  "work-thread-handoff-recovery",
] as const;

const requiredDomains = [
  "executive.approvals",
  "executive.briefing",
  "executive.delegation",
  "executive.documents",
  "executive.escalation",
  "executive.family",
  "executive.followup",
  "executive.hiring",
  "executive.household",
  "executive.legal",
  "executive.messaging",
  "executive.money",
  "executive.prioritization",
  "executive.privacy",
  "executive.schedule",
  "executive.travel",
  "executive.vendor",
] as const;

function scenarioFiles(): string[] {
  return readdirSync(scenarioDir)
    .filter((file) => file.endsWith(".scenario.ts"))
    .sort();
}

function readScenario(id: string): string {
  return readFileSync(resolve(scenarioDir, `${id}.scenario.ts`), "utf8");
}

describe("executive assistant scenario coverage", () => {
  it("keeps expanding LifeOps beyond habit reminders", () => {
    const files = scenarioFiles();

    expect(files.length).toBeGreaterThanOrEqual(50);
    for (const id of requiredScenarioIds) {
      expect(files).toContain(`${id}.scenario.ts`);
      expect(readScenario(id)).toContain("executive-assistant");
    }
  });

  it("covers the core chief-of-staff domains", () => {
    const corpus = scenarioFiles()
      .map((file) => readFileSync(resolve(scenarioDir, file), "utf8"))
      .join("\n");

    for (const domain of requiredDomains) {
      expect(corpus).toContain(`domain: "${domain}"`);
    }
  });
});
