/** Proves the hosting DTO matches continuous billing across tier and lifecycle states. */

import { describe, expect, it } from "vitest";
import { deriveAgentHostingCost, summarizeAgentHosting } from "./agent-hosting-presentation";

describe("agent hosting presentation", () => {
  it("keeps every shared lifecycle state out of continuous hosting", () => {
    for (const status of [
      "pending",
      "provisioning",
      "running",
      "stopped",
      "sleeping",
      "disconnected",
      "error",
      "deletion_pending",
      "deletion_failed",
    ] as const) {
      expect(
        deriveAgentHostingCost({
          executionTier: "shared",
          status,
          billingStatus: "active",
          lastBackupAt: null,
        }),
      ).toEqual({
        pricingState: "known",
        rateClass: "shared-usage",
        hourlyRateUsd: 0,
        monthlyEstimateUsd: 0,
      });
    }
  });

  it("summarizes mixed hosting without charging shared agents", () => {
    const summary = summarizeAgentHosting(
      [
        deriveAgentHostingCost({
          executionTier: "shared",
          status: "running",
          billingStatus: "active",
          lastBackupAt: null,
        }),
        deriveAgentHostingCost({
          executionTier: "dedicated-always",
          status: "running",
          billingStatus: "active",
          lastBackupAt: null,
        }),
        deriveAgentHostingCost({
          executionTier: "dedicated-lazy",
          status: "stopped",
          billingStatus: "active",
          lastBackupAt: "2026-08-12T00:00:00.000Z",
        }),
        deriveAgentHostingCost({
          executionTier: "dedicated-lazy",
          status: "sleeping",
          billingStatus: "suspended",
          lastBackupAt: "2026-08-12T00:00:00.000Z",
        }),
      ],
      5,
    );

    expect(summary).toMatchObject({
      pricingState: "complete",
      sharedCount: 1,
      dedicatedRunningCount: 1,
      dedicatedIdleCount: 1,
      dedicatedDeactivatedCount: 1,
      unavailableDedicatedCount: 0,
      hasAgents: true,
      hasDedicatedHosting: true,
      hourlyHostingCostUsd: 0.0125,
      monthlyHostingCostUsd: 9,
      creditBalanceUsd: 5,
      hoursRemaining: 400,
      lowBalance: false,
    });
  });

  it("reports all-shared hosting as zero with no fabricated runway", () => {
    expect(
      summarizeAgentHosting(
        [
          deriveAgentHostingCost({
            executionTier: "shared",
            status: "running",
            billingStatus: "active",
            lastBackupAt: null,
          }),
          deriveAgentHostingCost({
            executionTier: "shared",
            status: "provisioning",
            billingStatus: "active",
            lastBackupAt: null,
          }),
          deriveAgentHostingCost({
            executionTier: "shared",
            status: "stopped",
            billingStatus: "active",
            lastBackupAt: null,
          }),
        ],
        0.01,
      ),
    ).toMatchObject({
      pricingState: "complete",
      sharedCount: 3,
      dedicatedRunningCount: 0,
      dedicatedIdleCount: 0,
      dedicatedDeactivatedCount: 0,
      unavailableDedicatedCount: 0,
      hourlyHostingCostUsd: 0,
      monthlyHostingCostUsd: 0,
      hoursRemaining: null,
      lowBalance: false,
    });
  });

  it("matches the billing cron predicate for non-shared rows", () => {
    for (const status of ["pending", "provisioning", "error", "disconnected"] as const) {
      expect(
        deriveAgentHostingCost({
          executionTier: "dedicated-lazy",
          status,
          billingStatus: "active",
          lastBackupAt: null,
        }),
      ).toEqual({
        pricingState: "unavailable",
        rateClass: "unavailable",
        hourlyRateUsd: null,
        monthlyEstimateUsd: null,
      });
    }
    expect(
      deriveAgentHostingCost({
        executionTier: "dedicated-lazy",
        status: "stopped",
        billingStatus: "active",
        lastBackupAt: null,
      }).rateClass,
    ).toBe("unavailable");
    expect(
      deriveAgentHostingCost({
        executionTier: "dedicated-lazy",
        status: "running",
        billingStatus: "suspended",
        lastBackupAt: null,
      }).rateClass,
    ).toBe("unavailable");
  });

  it("marks mixed known and unavailable dedicated pricing incomplete", () => {
    const summary = summarizeAgentHosting(
      [
        deriveAgentHostingCost({
          executionTier: "shared",
          status: "running",
          billingStatus: "active",
          lastBackupAt: null,
        }),
        deriveAgentHostingCost({
          executionTier: "dedicated-always",
          status: "running",
          billingStatus: "active",
          lastBackupAt: null,
        }),
        deriveAgentHostingCost({
          executionTier: "dedicated-lazy",
          status: "provisioning",
          billingStatus: "active",
          lastBackupAt: null,
        }),
      ],
      5,
    );

    expect(summary).toMatchObject({
      pricingState: "incomplete",
      sharedCount: 1,
      dedicatedRunningCount: 1,
      unavailableDedicatedCount: 1,
      hasDedicatedHosting: true,
      hourlyHostingCostUsd: null,
      monthlyHostingCostUsd: null,
      hoursRemaining: null,
      lowBalance: null,
    });
  });
});
