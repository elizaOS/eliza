/**
 * Verifies the runtime-scoped browser activity store retains every accepted
 * report and aggregates the complete caller-requested time window.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../website-blocker/proactive-block-bridge.js", () => ({
  evaluateProactiveBlockOnBrowserFocus: vi.fn(async () => undefined),
}));

import {
  getBrowserDomainActivity,
  recordBrowserActivityReport,
} from "./browser-extension-store.js";

describe("browser extension activity retention", () => {
  it("does not discard reports after an internal item-count threshold", async () => {
    const runtime = {} as IAgentRuntime;
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const reportCount = 2_050;

    for (let index = 0; index < reportCount; index += 1) {
      const windowStartMs = start + index * 2;
      const windowEndMs = windowStartMs + 1;
      await recordBrowserActivityReport(runtime, {
        deviceId: "device-complete-history",
        windowStart: new Date(windowStartMs).toISOString(),
        windowEnd: new Date(windowEndMs).toISOString(),
        domains: [
          {
            domain: "example.com",
            focusMs: 1,
            sessionCount: 1,
            firstObservedAt: new Date(windowStartMs).toISOString(),
            lastObservedAt: new Date(windowEndMs).toISOString(),
          },
        ],
      });
    }

    await expect(
      getBrowserDomainActivity(runtime, {
        deviceId: "device-complete-history",
        domain: "example.com",
        sinceMs: start,
        untilMs: start + reportCount * 2,
      }),
    ).resolves.toEqual({ totalMs: reportCount, reportCount });
  });
});
