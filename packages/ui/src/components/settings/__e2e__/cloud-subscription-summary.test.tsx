/** Shared Cloud subscription surface: plan, allowance and a lapsing limit with its retry time. */
// @vitest-environment jsdom
import type { SubscriptionView } from "@elizaos/cloud-sdk/subscription-entitlement";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloudSubscriptionSummary,
  type ObservedServiceLimit,
} from "../cloud-subscription-summary";

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const DAY = 86_400_000;
const active: SubscriptionView = {
  kind: "active",
  planName: "Plus",
  status: "active",
  allowance: {
    unit: "usd_micros",
    granted: 10_000_000,
    remaining: 2_500_000,
    periodStart: NOW - 4 * DAY,
    resetsAt: NOW + 3 * DAY,
  },
  expiresAt: NOW + 60 * 60 * 1000,
  refreshFailed: false,
  planEndsAt: NOW + 10 * DAY,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CloudSubscriptionSummary", () => {
  it("shows the active plan with its end and no limit row", () => {
    render(<CloudSubscriptionSummary view={active} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText(/^Plus/)).toBeTruthy();
    expect(screen.getByText(/10 days left/)).toBeTruthy();
    expect(
      document.querySelector("[data-cloud-subscription-summary] dd")
        ?.textContent,
    ).toMatch(/left/);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a rate limit with its retry time and removes it when the wait ends", () => {
    const limit: ObservedServiceLimit = {
      kind: "rate-limited",
      retryAfterMs: 90_000,
      resetsAt: null,
      observedAt: NOW,
    };
    render(<CloudSubscriptionSummary view={active} lastLimit={limit} />);
    const row = screen.getByRole("status");
    expect(row.textContent).toBeTruthy();
    expect(screen.getByText("AI requests")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(91_000);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("leaves out the plan row when the host shows the plan", () => {
    const limit: ObservedServiceLimit = {
      kind: "allowance-exhausted",
      retryAfterMs: null,
      resetsAt: NOW + DAY,
      observedAt: NOW,
    };
    render(
      <CloudSubscriptionSummary
        view={active}
        lastLimit={limit}
        hidePlan
        limitLabel="Requests"
        className="themed"
      />,
    );
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.getByText("Requests")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBeTruthy();
    expect(
      document.querySelector("[data-cloud-subscription-summary]")?.className,
    ).toBe("themed");
  });

  it("describes a missing plan without inventing one", () => {
    render(
      <CloudSubscriptionSummary
        view={{
          kind: "inactive",
          planName: null,
          status: "none",
          source: "entitlement",
        }}
        copy={{ serviceName: "Eliza Cloud" }}
      />,
    );
    expect(screen.queryByText(/days left/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
