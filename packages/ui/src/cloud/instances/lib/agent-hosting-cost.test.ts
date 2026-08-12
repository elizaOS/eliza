/** Verifies shared and dedicated hosting classifications without rendering the console. */

import { AGENT_PRICING } from "@elizaos/cloud-shared/lib/constants/agent-pricing";
import { describe, expect, it } from "vitest";
import {
  getAgentHostingCost,
  summarizeAgentHosting,
} from "./agent-hosting-cost";

describe("getAgentHostingCost", () => {
  it.each(["running", "stopped", "provisioning", "error"])(
    "keeps shared %s agents out of continuous hosting",
    (status) => {
      expect(getAgentHostingCost({ executionTier: "shared", status })).toEqual({
        rateClass: "shared-usage",
        hourlyRate: 0,
      });
    },
  );

  it("preserves dedicated running, idle, provisioning, and deactivated semantics", () => {
    expect(
      getAgentHostingCost({
        executionTier: "dedicated-always",
        status: "running",
      }),
    ).toEqual({
      rateClass: "running",
      hourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
    });
    expect(
      getAgentHostingCost({
        executionTier: "dedicated-lazy",
        status: "stopped",
      }),
    ).toEqual({
      rateClass: "idle",
      hourlyRate: AGENT_PRICING.IDLE_HOURLY_RATE,
    });
    expect(
      getAgentHostingCost({
        executionTier: "custom",
        status: "provisioning",
      }),
    ).toEqual({
      rateClass: "provisioning",
      hourlyRate: AGENT_PRICING.RUNNING_HOURLY_RATE,
    });
    expect(
      getAgentHostingCost({
        executionTier: "dedicated-lazy",
        status: "sleeping",
      }),
    ).toEqual({
      rateClass: "deactivated",
      hourlyRate: 0,
    });
  });
});

describe("summarizeAgentHosting", () => {
  it("reports all-shared lists without dedicated hosting burn", () => {
    expect(
      summarizeAgentHosting([
        { executionTier: "shared", status: "running" },
        { executionTier: "shared", status: "running" },
        { executionTier: "shared", status: "running" },
      ]),
    ).toEqual({
      sharedCount: 3,
      dedicatedRunningCount: 0,
      dedicatedIdleCount: 0,
    });
  });

  it("separates mixed shared and dedicated lists", () => {
    expect(
      summarizeAgentHosting([
        { executionTier: "shared", status: "running" },
        { executionTier: "dedicated-always", status: "running" },
        { executionTier: "dedicated-lazy", status: "stopped" },
        { executionTier: "custom", status: "disconnected" },
        { executionTier: "dedicated-lazy", status: "provisioning" },
        { executionTier: "dedicated-lazy", status: "sleeping" },
      ]),
    ).toEqual({
      sharedCount: 1,
      dedicatedRunningCount: 1,
      dedicatedIdleCount: 2,
    });
  });
});
