/**
 * Executive-assistant scenario corpus gate.
 *
 * Loads every `*.scenario.ts` in `test/scenarios/` through the REAL
 * scenario-runner loader (`discoverScenarios` + `loadScenarioFile` — the same
 * code path `eliza-scenarios run` uses) and inspects the loaded structure:
 *
 *  - every file loads and passes the loader's ScenarioDefinition shape check;
 *  - scenario ids are unique and match their filename (discoverability);
 *  - every scenario carries at least one load-bearing assertion (finalChecks,
 *    assertTurn, planner matchers, expectedActions, forbiddenActions,
 *    assertResponse, responseJudge, or responseExcludes). `responseIncludesAny`
 *    / `responseIncludesAll` alone do NOT count — a scenario whose only
 *    assertion is "the reply echoes a keyword" is vacuous coverage (#9310);
 *  - the required executive-assistant ids exist and are tagged;
 *  - the chief-of-staff domains are covered by loaded `domain` fields.
 *
 * A previous version of this gate only asserted that files exist and contain
 * substrings ("executive-assistant", `domain: "..."`) — a scenario file full
 * of prose with zero runnable turns satisfied it. This version fails on a
 * scenario that does not load or asserts nothing.
 */

import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  discoverScenarios,
  loadScenarioFile,
} from "../../../packages/scenario-runner/src/loader.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, "scenarios");

const requiredScenarioIds = [
  "acquisition-dataroom-cleanup",
  "anonymous-donor-diligence",
  "auction-bid-approval-window",
  "bill-approval-and-payment",
  "board-consent-signature-emergency",
  "board-meeting-prebrief-risk-register",
  "board-observer-conflict-disclosure",
  "board-packet-correction-sweep",
  "caregiver-shift-transition",
  "childcare-backup-plan",
  "concierge-vip-itinerary-recovery",
  "conference-agenda-relationship-map",
  "conference-room-crisis-recovery",
  "conference-speaker-greenroom",
  "consulate-interview-recovery",
  "complex-travel-reimbursement",
  "confidential-recruiting-reference-check",
  "credential-rotation-dependency-map",
  "credit-card-fraud-replacement",
  "critical-vendor-sla-credit",
  "cross-border-wire-approval-hold",
  "crisis-comms-family-office",
  "cyber-insurance-notice-window",
  "daily-brief-cross-channel",
  "data-breach-vendor-notification",
  "delegation-map-status-compression",
  "document-signature-chase",
  "draft-approval-sweep",
  "eldercare-appointment-paperwork",
  "emergency-litigation-hold-executive",
  "emergency-home-evacuation-runbook",
  "art-shipping-insurance-claim",
  "art-auction-provenance-diligence",
  "estate-admin-document-safe",
  "estate-insurance-inventory",
  "estate-liquidity-tax-call",
  "equity-option-exercise-window",
  "executive-device-loss-response",
  "executive-gifting-compliance",
  "executive-security-travel-protocol",
  "expat-payroll-shadow-tax",
  "family-office-quarterly-board-book",
  "family-trust-beneficiary-briefing",
  "family-work-conflict-repair",
  "founder-equity-admin-window",
  "gala-seating-conflict-repair",
  "group-chat-handoff-proposal",
  "hiring-loop-candidate-coordination",
  "home-repair-contractor-coordination",
  "home-security-incident-recovery",
  "household-staff-background-check",
  "household-staff-payroll-correction",
  "household-move-utilities-transfer",
  "household-insurance-renewal-gap",
  "insurance-claim-paperwork",
  "international-school-application",
  "ipo-lockup-liquidity-window",
  "kid-camp-medical-form-deadline",
  "investor-diligence-followup",
  "investor-update-digest",
  "keynote-slide-fact-check-approval",
  "legal-deadline-redline",
  "lease-renewal-option-window",
  "litigation-hold-custodian-sweep",
  "major-event-guest-logistics",
  "medical-bill-appeal-coordination",
  "media-correction-escalation",
  "media-appearance-prep-firebreak",
  "medical-poa-document-chase",
  "memorial-logistics-family-brief",
  "missed-call-repair-reschedule",
  "minor-emergency-passport",
  "nda-counterparty-redline-handoff",
  "nanny-payroll-tax-admin",
  "passport-renewal-travel-readiness",
  "passport-visa-consulate-escalation",
  "pet-relocation-quarantine",
  "philanthropy-grant-diligence",
  "private-school-tuition-contract-review",
  "priority-triage-mixed-sources",
  "privacy-redaction-forward",
  "private-aviation-crew-swap",
  "private-chef-dietary-firebreak",
  "property-tax-reassessment-appeal",
  "probate-beneficiary-document-chase",
  "product-launch-media-travel-brief",
  "proxy-vote-instruction-deadline",
  "quarterly-tax-payment-runbook",
  "recurring-report-chase-metrics",
  "regulatory-comment-deadline",
  "release-branch-war-room",
  "reputation-crisis-screenshot-preservation",
  "school-accommodation-privacy",
  "school-family-calendar-carpool",
  "school-incident-parent-comms",
  "school-trip-permission-stack",
  "security-incident-account-lockdown",
  "shareholder-letter-fact-check",
  "subscription-cancel-save",
  "succession-comms-holdback",
  "tax-deadline-prep",
  "travel-blackout-bulk-reschedule",
  "travel-companion-rebooking-recovery",
  "travel-disruption-decision-tree",
  "urgent-invoice-fraud-review",
  "vendor-access-revocation",
  "vendor-negotiation-approval",
  "board-offsite-accessibility-logistics",
  "vendor-failure-home-recovery",
  "vip-escalation-firebreak",
  "visa-renewal-travel-blocker",
  "wealth-transfer-approval",
  "weather-closure-childcare-recovery",
  "work-thread-handoff-recovery",
  "art-storage-renewal-valuation",
  "board-dinner-dietary-privacy",
  "caregiver-background-renewal",
  "domain-renewal-admin-takeover",
  "donor-pledge-payment-coordination",
  "emergency-replacement-id-logistics",
  "executive-assistant-handoff-continuity",
  "luxury-return-fraud-review",
  "media-embargo-briefing",
  "minor-travel-consent-notarization",
  "renovation-lien-waiver-payment",
  "speaking-fee-collection-chase",
  "subpoena-intake-counsel-hold",
  "trust-distribution-approval",
  "utility-outage-reimbursement",
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

/**
 * Turn-level assertion fields the executor enforces that a canned/echoing
 * reply cannot trivially satisfy. `responseIncludesAny` / `responseIncludesAll`
 * are deliberately absent: keyword-echo assertions are tracked (and only
 * allowed to shrink) by the scenario-runner echo-assertion ratchet.
 */
const LOAD_BEARING_TURN_FIELDS = [
  "assertTurn",
  "assertResponse",
  "expectedActions",
  "forbiddenActions",
  "plannerIncludesAll",
  "plannerIncludesAny",
  "plannerExcludes",
  "responseExcludes",
  "responseJudge",
] as const;

function hasLoadBearingAssertion(scenario: ScenarioDefinition): boolean {
  const finalChecks = (scenario as { finalChecks?: unknown[] }).finalChecks;
  if (Array.isArray(finalChecks) && finalChecks.length > 0) return true;
  return scenario.turns.some((turn) =>
    LOAD_BEARING_TURN_FIELDS.some(
      (field) => (turn as Record<string, unknown>)[field] !== undefined,
    ),
  );
}

async function loadCorpus(): Promise<
  Array<{ file: string; scenario: ScenarioDefinition }>
> {
  const files = await discoverScenarios(scenarioDir);
  return Promise.all(files.map((file) => loadScenarioFile(file)));
}

// Loading ~190 scenario modules through the real loader is one shared,
// order-independent read — do it once for the whole suite.
const corpusPromise = loadCorpus();

describe("executive assistant scenario coverage", () => {
  it("every scenario file loads through the real scenario loader", async () => {
    const corpus = await corpusPromise;

    // Deletion guard: the corpus may only grow.
    expect(corpus.length).toBeGreaterThanOrEqual(155);

    // Unique ids, and each id matches its filename so `--filter <id>` and the
    // file on disk always agree.
    const ids = new Set<string>();
    for (const { file, scenario } of corpus) {
      expect(
        ids.has(scenario.id),
        `duplicate scenario id ${scenario.id} (${file})`,
      ).toBe(false);
      ids.add(scenario.id);
      expect(basename(file), `id/filename mismatch in ${file}`).toBe(
        `${scenario.id}.scenario.ts`,
      );
      expect(
        scenario.turns.length,
        `${scenario.id} has no turns — nothing to run`,
      ).toBeGreaterThan(0);
    }
  });

  it("every scenario carries at least one load-bearing assertion", async () => {
    const corpus = await corpusPromise;
    const vacuous = corpus
      .filter(({ scenario }) => !hasLoadBearingAssertion(scenario))
      .map(({ scenario }) => scenario.id);
    expect(
      vacuous,
      "scenarios with no enforceable assertion beyond keyword echo — add finalChecks, assertTurn, planner matchers, or expectedActions",
    ).toEqual([]);
  });

  it("keeps expanding LifeOps beyond habit reminders", async () => {
    const corpus = await corpusPromise;
    const byId = new Map(corpus.map(({ scenario }) => [scenario.id, scenario]));
    for (const id of requiredScenarioIds) {
      const scenario = byId.get(id);
      expect(scenario, `required scenario ${id} is missing`).toBeDefined();
      expect(
        (scenario as { tags?: string[] }).tags ?? [],
        `${id} lost its executive-assistant tag`,
      ).toContain("executive-assistant");
    }
  });

  it("covers the core chief-of-staff domains", async () => {
    const corpus = await corpusPromise;
    const domains = new Set(corpus.map(({ scenario }) => scenario.domain));
    for (const domain of requiredDomains) {
      expect(
        domains.has(domain),
        `no loaded scenario covers domain ${domain}`,
      ).toBe(true);
    }
  });
});
