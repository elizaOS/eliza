/** Visual-state contract tests for active compute observations and controls. */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
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
    cancellationControl: {
      displayAction: "stop",
      method: "POST",
      mode: "stop",
      endpoint:
        "/api/v1/billing/resources/container-1234567890/cancel?resourceType=container",
      expectedLifecycleRevision: 7,
      eligible: true,
      blockers: [],
    },
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

  it("requires explicit confirmation and warns that billing continues", async () => {
    const onRequestCancellation = vi.fn();
    const resource = computeResource();
    render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Stop" });
    expect(trigger.className).toMatch(/min-h-11/);
    expect(trigger.className).toMatch(/keyboard-focus-surface/);
    fireEvent.click(trigger);

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Stop this container?");
    expect(dialog.textContent).toContain(
      "Billing continues until the provider confirms the stop.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep running" }),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(onRequestCancellation).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Stop",
      }),
    );
    expect(onRequestCancellation).toHaveBeenCalledWith(resource);
  });

  it("moves focus to the durable status when confirmation removes its trigger", async () => {
    const resource = computeResource();
    const identity = "container:container-1234567890:7";

    function FocusRecoveryHarness() {
      const [submitted, setSubmitted] = useState(false);
      return (
        <ActiveComputeCardView
          state={ready(snapshot({ resources: available([resource]) }))}
          onRetry={vi.fn()}
          onRequestCancellation={() => setSubmitted(true)}
          cancellationStates={
            submitted ? { [identity]: { kind: "submitting" } } : {}
          }
        />
      );
    }

    render(<FocusRecoveryHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Stop",
      }),
    );

    const detail = await screen.findByText(
      "Submitting the durable request. Billing is still active.",
    );
    const status = detail.closest('[role="status"]');
    expect(status).toBeInstanceOf(HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("closes an open confirmation and focuses its durable accepted status", async () => {
    const resource = computeResource();
    const identity = "container:container-1234567890:7";
    const onRequestCancellation = vi.fn();
    const readyState = ready(snapshot({ resources: available([resource]) }));
    const { rerender } = render(
      <ActiveComputeCardView
        state={readyState}
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    const staleAction = within(screen.getByRole("alertdialog")).getByRole(
      "button",
      { name: "Stop" },
    );

    rerender(
      <ActiveComputeCardView
        state={readyState}
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
        cancellationStates={{
          [identity]: {
            kind: "accepted",
            receiptId: "22222222-2222-4222-8222-222222222222",
          },
        }}
      />,
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(staleAction.isConnected).toBe(false);
    fireEvent.click(staleAction);
    expect(onRequestCancellation).not.toHaveBeenCalled();

    const detail = screen.getByText(
      "Request accepted. Billing remains active until provider confirmation.",
    );
    const status = detail.closest('[role="status"]');
    expect(status).toBeInstanceOf(HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("discards an open confirmation when the lifecycle revision rotates", async () => {
    const onRequestCancellation = vi.fn();
    const revisionSeven = computeResource();
    const revisionEight = {
      ...revisionSeven,
      cancellationControl: {
        ...revisionSeven.cancellationControl,
        expectedLifecycleRevision: 8,
      },
    };
    const { rerender } = render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([revisionSeven]) }))}
        cancellationAuthorityKey="org-a:user-a"
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    rerender(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([revisionEight]) }))}
        cancellationAuthorityKey="org-a:user-a"
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
      />,
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
    const currentTrigger = screen.getByRole("button", { name: "Stop" });
    await waitFor(() => expect(document.activeElement).toBe(currentTrigger));
    expect(onRequestCancellation).not.toHaveBeenCalled();
  });

  it("discards an open confirmation when the authenticated principal rotates", async () => {
    const onRequestCancellation = vi.fn();
    const resource = computeResource();
    const renderView = (authority: string) => (
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        cancellationAuthorityKey={authority}
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
      />
    );
    const { rerender } = render(renderView("org-a:user-a"));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    rerender(renderView("org-a:user-b"));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    const currentTrigger = screen.getByRole("button", { name: "Stop" });
    await waitFor(() => expect(document.activeElement).toBe(currentTrigger));
    expect(onRequestCancellation).not.toHaveBeenCalled();
  });

  it("focuses the authoritative blocker when eligibility changes mid-confirmation", async () => {
    const onRequestCancellation = vi.fn();
    const eligible = computeResource();
    const blocked = computeResource({
      cancellationControl: {
        ...eligible.cancellationControl,
        eligible: false,
        blockers: ["owner_or_admin_role_required"],
      },
    });
    const { rerender } = render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([eligible]) }))}
        cancellationAuthorityKey="org-a:user-a"
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    rerender(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([blocked]) }))}
        cancellationAuthorityKey="org-a:user-a"
        onRetry={vi.fn()}
        onRequestCancellation={onRequestCancellation}
      />,
    );

    expect(screen.queryByRole("alertdialog")).toBeNull();
    const blocker = screen
      .getByText(
        "Only organization owners and admins can manage billing for this resource.",
      )
      .closest('[role="status"]');
    expect(blocker).toBeInstanceOf(HTMLElement);
    await waitFor(() => expect(document.activeElement).toBe(blocker));
    expect(onRequestCancellation).not.toHaveBeenCalled();
  });

  it("offers a safe retry after a rejected request", () => {
    const resource = computeResource();
    render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={vi.fn()}
        cancellationStates={{
          "container:container-1234567890:7": { kind: "rejected" },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Retry request" })).toBeTruthy();
  });

  it("renders the server blocker instead of an active control", () => {
    const resource = computeResource({
      cancellationControl: {
        displayAction: "stop",
        method: "POST",
        mode: "stop",
        endpoint:
          "/api/v1/billing/resources/container-1234567890/cancel?resourceType=container",
        expectedLifecycleRevision: 7,
        eligible: false,
        blockers: ["owner_or_admin_role_required"],
      },
    });
    render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Only organization owners and admins can manage billing for this resource.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("explains an account eligibility blocker without exposing an action", () => {
    const resource = computeResource({
      cancellationControl: {
        displayAction: "stop",
        method: "POST",
        mode: "stop",
        endpoint:
          "/api/v1/billing/resources/container-1234567890/cancel?resourceType=container",
        expectedLifecycleRevision: 7,
        eligible: false,
        blockers: ["billing_account_ineligible"],
      },
    });
    render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "This account or organization is not eligible to manage billing for this resource.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("keeps the resource visible after acceptance and exposes the receipt", () => {
    const resource = computeResource();
    render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={vi.fn()}
        cancellationStates={{
          "container:container-1234567890:7": {
            kind: "accepted",
            receiptId: "22222222-2222-4222-8222-222222222222",
          },
        }}
      />,
    );

    expect(screen.getByText("API container")).toBeTruthy();
    expect(
      screen.getByText(
        "Request accepted. Billing remains active until provider confirmation.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Receipt: 22222222-2222-4222-8222-222222222222"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("distinguishes provider confirmation from terminal attention", () => {
    const resource = computeResource();
    const identity = "container:container-1234567890:7";
    const { rerender } = render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={vi.fn()}
        cancellationStates={{
          [identity]: {
            kind: "provider_confirmed",
            receiptId: "22222222-2222-4222-8222-222222222222",
            computeStopped: true,
            providerStopped: true,
            retainedBackupBilling: {
              status: "not_applicable",
              ratePerHour: null,
            },
          },
        }}
      />,
    );
    expect(
      screen.getByText(
        "Provider confirmed compute stopped. No retained backup billing remains for this resource.",
      ),
    ).toBeTruthy();

    rerender(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={vi.fn()}
        cancellationStates={{
          [identity]: {
            kind: "terminal_attention",
            receiptId: "22222222-2222-4222-8222-222222222222",
          },
        }}
      />,
    );
    const attentionAlert = screen.getByRole("alert");
    expect(attentionAlert.textContent).toMatch(/operator attention/i);
    expect(attentionAlert.textContent).toMatch(/provider.*not confirmed/i);
    expect(attentionAlert.textContent).toMatch(/billing continues/i);
    expect(attentionAlert.textContent).not.toMatch(
      /provider confirmed compute stopped/i,
    );
  });

  it("keeps retained agent-backup billing explicit after compute stops", () => {
    const resource = computeResource({
      resourceType: "agent_sandbox",
      resourceId: "agent-1234567890",
      name: "Research agent",
      cancellationControl: {
        displayAction: "stop_compute",
        method: "POST",
        mode: "stop",
        endpoint:
          "/api/v1/billing/resources/agent-1234567890/cancel?resourceType=agent_sandbox",
        expectedLifecycleRevision: 7,
        eligible: true,
        blockers: [],
      },
    });

    render(
      <ActiveComputeCardView
        state={ready(snapshot({ resources: available([resource]) }))}
        onRetry={vi.fn()}
        onRequestCancellation={vi.fn()}
        cancellationStates={{
          "agent_sandbox:agent-1234567890:7": {
            kind: "provider_confirmed",
            receiptId: "22222222-2222-4222-8222-222222222222",
            computeStopped: true,
            providerStopped: true,
            retainedBackupBilling: {
              status: "billable",
              ratePerHour: 0.0025,
            },
          },
        }}
      />,
    );

    expect(
      screen.getByText(
        "Provider confirmed compute stopped. The retained backup remains billable at $0.0025/hour until it is deleted.",
      ),
    ).toBeTruthy();
  });
});
