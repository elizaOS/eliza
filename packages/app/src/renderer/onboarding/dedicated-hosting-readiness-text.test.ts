import type { DedicatedAdoptionConfirmationQuote } from "@elizaos/ui";
import { describe, expect, it } from "vitest";
import { dedicatedHostingReadinessText } from "./dedicated-hosting-readiness-text";

const existing: DedicatedAdoptionConfirmationQuote = {
  quoteId: "quote-private",
  dedicatedAgentId: "agent-private",
  adoptionState: "available",
  status: "stopped",
  startsCompute: true,
  hourlyRateUsd: 0.01,
  minimumActivationChargeUsd: 0.02,
  dailyRateUsd: 0.24,
  minimumBalanceUsd: 1.68,
  minimumRunwayDays: 7,
  balanceUsd: 10,
  deficitUsd: 0,
  stateDisposition: "verified_backup_present",
  canAdopt: true,
  requiresCatalogRestore: false,
  requiresConfirmation: true,
  action: "adopt_existing_dedicated",
};

describe("Dedicated hosting readiness disclosure", () => {
  it("shows the server's status, runway and compute effect before adoption", () => {
    const text = dedicatedHostingReadinessText(existing).join("\n");
    expect(text).toContain("Current status: stopped.");
    expect(text).toContain("7 days of hosting");
    expect(text).toContain("Confirming starts Dedicated compute.");
    expect(text).not.toContain("private");
  });

  it("does not infer running compute from a no-start decision", () => {
    const text = dedicatedHostingReadinessText({
      ...existing,
      status: "pending_review",
      startsCompute: false,
    }).join("\n");
    expect(text).toContain("Current status: pending review.");
    expect(text).toContain("Confirming does not start new Dedicated compute.");
    expect(text).not.toContain("already active");
  });

  it("discloses activation runway without inventing an existing host status", () => {
    const text = dedicatedHostingReadinessText({
      ...existing,
      action: "activate_dedicated",
      sourceAgentId: "source-private",
      canActivate: true,
      minimumRunwayDays: 2.5,
    }).join("\n");
    expect(text).toContain("2.5 days of hosting");
    expect(text).toContain("Confirming starts Dedicated compute.");
    expect(text).not.toContain("Current status");
  });
});
