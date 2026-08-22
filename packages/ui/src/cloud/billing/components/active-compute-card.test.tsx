/** Visual-state contract tests for the read-only active compute card. */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: Record<string, unknown>) => {
    let value = String(options?.defaultValue ?? _key);
    for (const [name, replacement] of Object.entries(options ?? {})) {
      if (name === "defaultValue") continue;
      value = value.replaceAll(`{{${name}}}`, String(replacement));
    }
    return value;
  },
}));

import type {
  BillingSnapshotResource,
  BillingSnapshotV2View,
} from "../data/billing-snapshot";
import {
  ActiveComputeCardView,
  type BillingSnapshotViewState,
} from "./active-compute-card";

const OBSERVED_AT = "2026-08-21T10:20:30.000Z";

function available<T>(value: T, source = "billing-test") {
  return {
    status: "available" as const,
    source,
    observedAt: OBSERVED_AT,
    value,
  };
}

function unavailable(retryable: boolean) {
  return {
    status: "unavailable" as const,
    source: "billing-test",
    observedAt: OBSERVED_AT,
    error: { code: "source_unavailable", retryable },
  };
}

function exact<Unit extends "usd" | "usd_per_hour" | "usd_per_day">(
  value: string,
  unit: Unit,
) {
  return { value, unit, currency: "USD" as const };
}

function computeResource(
  overrides: Partial<BillingSnapshotResource> = {},
): BillingSnapshotResource {
  return {
    resourceType: "container",
    resourceId: "container-1234567890",
    name: "API container",
    status: "running",
    billingStatus: "active",
    billingInterval: "day",
    lastBilledAt: "2026-08-21T09:00:00.000Z",
    nextBillingAt: "2026-08-22T09:00:00.000Z",
    estimatedNextBillingAt: "2026-08-21T11:00:00.000Z",
    ratePerHour: available(exact("0.123456", "usd_per_hour")),
    estimatedRecurringComputeCostPerDay: available(
      exact("2.962944", "usd_per_day"),
    ),
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<BillingSnapshotV2View["activeCompute"]> = {},
): BillingSnapshotV2View {
  return {
    snapshotStartedAt: OBSERVED_AT,
    snapshotCompletedAt: OBSERVED_AT,
    balance: available({
      balance: exact("12.500000", "usd"),
      revision: "7",
    }),
    activeCompute: {
      resources: available([computeResource()]),
      estimatedRecurringComputeCostPerDay: available(
        exact("2.962944", "usd_per_day"),
      ),
      ...overrides,
    },
  };
}

function ready(
  value = snapshot(),
  overrides: Partial<Extract<BillingSnapshotViewState, { kind: "ready" }>> = {},
): BillingSnapshotViewState {
  return {
    kind: "ready",
    snapshot: value,
    refreshing: false,
    refreshPaused: false,
    refreshFailed: false,
    ...overrides,
  };
}

afterEach(() => cleanup());

function resourceCard(name: string): HTMLElement {
  const card = screen.getByText(name, { exact: true }).closest("li");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`Resource card not found for ${name}`);
  }
  return card;
}

function expectDefinitionValue(
  card: HTMLElement,
  label: string,
  value: string,
): void {
  const term = within(card).getByText(label, { exact: true, selector: "dt" });
  const definition = term.nextElementSibling;
  expect(definition?.tagName).toBe("DD");
  expect(definition?.textContent).toBe(value);
}

describe("ActiveComputeCardView", () => {
  it("renders a stable loading skeleton without inventing empty or zero", () => {
    render(
      <ActiveComputeCardView state={{ kind: "loading" }} onRetry={vi.fn()} />,
    );

    expect(
      screen
        .getByRole("status", { name: "Loading active compute" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.queryByText("No active billable compute")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("shows a generic whole-request error and a 44px retry action", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ActiveComputeCardView
        state={{ kind: "error", retrying: false }}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Active compute unavailable",
    );
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.className).toMatch(/min-h-11/);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ActiveComputeCardView
        state={{ kind: "error", retrying: true }}
        onRetry={onRetry}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Retrying…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("distinguishes paused transport from an error retry state", () => {
    render(
      <ActiveComputeCardView state={{ kind: "paused" }} onRetry={vi.fn()} />,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Waiting for a connection",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders authoritative empty only when the resources observation is available", () => {
    render(
      <ActiveComputeCardView
        state={ready(
          snapshot({
            resources: available([]),
            estimatedRecurringComputeCostPerDay: available(
              exact("0.000000", "usd_per_day"),
            ),
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("No active billable compute")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
  });

  it("keeps unavailable distinct from empty and only offers an honest retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: unavailable(true) }))}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Active resources cannot be shown from this observation",
    );
    expect(screen.queryByText("No active billable compute")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: unavailable(false) }))}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers retry when aggregate cost is retryable but resources are not", () => {
    const onRetry = vi.fn();
    render(
      <ActiveComputeCardView
        state={ready(
          snapshot({
            resources: unavailable(false),
            estimatedRecurringComputeCostPerDay: unavailable(true),
          }),
        )}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps healthy resources visible when one exact rate is unavailable", () => {
    const resource = computeResource({ ratePerHour: unavailable(true) });
    const { rerender } = render(
      <ActiveComputeCardView
        state={ready(
          snapshot({
            resources: available([resource]),
            estimatedRecurringComputeCostPerDay: unavailable(false),
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("API container")).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/No estimate is recalculated in the client/),
    ).toHaveLength(2);
    expect(screen.getByRole("status").textContent).toContain(
      "Some cost observations are unavailable",
    );
    expect(screen.getByText("$2.962944")).toBeTruthy();

    rerender(
      <ActiveComputeCardView state={ready(snapshot())} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Active compute snapshot ready.",
    );
  });

  it("labels the aggregate observation time instead of snapshot completion", () => {
    const value = snapshot();
    value.snapshotCompletedAt = "2026-08-21T11:22:33.000Z";
    render(<ActiveComputeCardView state={ready(value)} onRetry={vi.fn()} />);

    expect(screen.getByText("Observed 2026-08-21 10:20:30 UTC")).toBeTruthy();
    expect(screen.queryByText(/11:22:33/)).toBeNull();
  });

  it("uses the server aggregate and never sums resource estimates", () => {
    const first = computeResource({
      resourceId: "one",
      estimatedRecurringComputeCostPerDay: available(
        exact("1.000000", "usd_per_day"),
      ),
    });
    const second = computeResource({
      resourceId: "two",
      resourceType: "agent_sandbox",
      estimatedRecurringComputeCostPerDay: available(
        exact("2.000000", "usd_per_day"),
      ),
    });
    render(
      <ActiveComputeCardView
        state={ready(
          snapshot({
            resources: available([first, second]),
            estimatedRecurringComputeCostPerDay: available(
              exact("99.123456", "usd_per_day"),
            ),
          }),
        )}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("$99.123456")).toBeTruthy();
    expect(screen.queryByText("$3.00")).toBeNull();
  });

  it("shows server-owned billing period and cursors without client inference", () => {
    const container = computeResource({
      billingInterval: "hour",
      lastBilledAt: null,
      nextBillingAt: "2026-08-22T09:10:11.000Z",
      estimatedNextBillingAt: null,
    });
    const sandbox = computeResource({
      resourceType: "agent_sandbox",
      resourceId: "sandbox-one",
      name: "Research sandbox",
      billingInterval: "day",
      lastBilledAt: "2026-08-20T08:07:06.000Z",
      nextBillingAt: null,
      estimatedNextBillingAt: "2026-08-23T12:34:56.000Z",
    });
    render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([container, sandbox]) }))}
        onRetry={vi.fn()}
      />,
    );

    const containerCard = resourceCard("API container");
    expect(
      within(containerCard).getByText("Container · container-1234567890", {
        exact: true,
      }),
    ).toBeTruthy();
    expectDefinitionValue(containerCard, "Billing period", "Hourly");
    expectDefinitionValue(containerCard, "Last billed", "Not reported");
    expectDefinitionValue(
      containerCard,
      "Next billing",
      "2026-08-22 09:10:11 UTC",
    );
    expectDefinitionValue(
      containerCard,
      "Estimated next billing",
      "Not estimated",
    );

    const sandboxCard = resourceCard("Research sandbox");
    expect(
      within(sandboxCard).getByText("Agent sandbox · sandbox-one", {
        exact: true,
      }),
    ).toBeTruthy();
    expectDefinitionValue(sandboxCard, "Billing period", "Daily");
    expectDefinitionValue(
      sandboxCard,
      "Last billed",
      "2026-08-20 08:07:06 UTC",
    );
    expectDefinitionValue(sandboxCard, "Next billing", "Not scheduled");
    expectDefinitionValue(
      sandboxCard,
      "Estimated next billing",
      "2026-08-23 12:34:56 UTC",
    );
  });

  it("preserves a long exact value and reflows resources without a table", () => {
    const long = computeResource({
      resourceId:
        "resource-with-a-very-long-identifier-that-must-wrap-at-320px",
      name: "A very long active compute resource name that remains readable",
      ratePerHour: available(
        exact("900719925474099312345678.123456", "usd_per_hour"),
      ),
    });
    const { container } = render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([long]) }))}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen.getByText("$900,719,925,474,099,312,345,678.123456"),
    ).toBeTruthy();
    const list = screen.getByRole("list");
    expect(list.className).toMatch(/grid-cols-1/);
    expect(container.querySelector("table")).toBeNull();
    expect(container.innerHTML).not.toContain("min-w-[600px]");
    expect(within(list).getByRole("listitem").textContent).toContain(
      "resource-with-a-very-long-identifier",
    );
  });

  it("renders unknown policy and not-applicable as explicit non-zero states", () => {
    const unknown = {
      status: "unknown_policy" as const,
      source: "billing-test",
      observedAt: OBSERVED_AT,
      blockedBy: ["#23091"],
    };
    const notApplicable = {
      status: "not_applicable" as const,
      source: "billing-test",
      observedAt: OBSERVED_AT,
      reason: "no compute authority",
    };
    const { rerender } = render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: unknown }))}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Pending policy")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();

    rerender(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: notApplicable }))}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Not applicable")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("keeps cached rows visible while refreshing and after a refresh failure", () => {
    const { rerender } = render(
      <ActiveComputeCardView
        state={ready(snapshot(), { refreshing: true })}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Refreshing")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Refreshing active compute.",
    );
    expect(screen.getByText("API container")).toBeTruthy();

    rerender(
      <ActiveComputeCardView
        state={ready(snapshot(), { refreshFailed: true })}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not refresh. Showing the snapshot completed at",
    );
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByText("API container")).toBeTruthy();
  });
});
