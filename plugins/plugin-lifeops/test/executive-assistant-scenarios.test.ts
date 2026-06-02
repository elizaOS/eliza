import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

    expect(files.length).toBeGreaterThanOrEqual(155);
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
