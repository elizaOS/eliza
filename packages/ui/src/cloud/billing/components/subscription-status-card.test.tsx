/** Exercises subscription status, manager-only portal and period-end cancel/undo through the real React Query consumer with a deterministic SDK boundary. */
// @vitest-environment jsdom
import type { Observed } from "@elizaos/cloud-sdk/account-billing-snapshot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { BillingSubscriptionView } from "../data/billing-snapshot";
import { SubscriptionStatusCard } from "./subscription-status-card";

const sdk = vi.hoisted(() => ({
  createSubscriptionPortalSession: vi.fn(),
  submitOrganizationSubscriptionCancellation: vi.fn(),
  readOrganizationSubscriptionCancellation: vi.fn(),
  submitOrganizationSubscriptionCancellationUndo: vi.fn(),
  readOrganizationSubscriptionCancellationUndo: vi.fn(),
}));
vi.mock("../../lib/cloud-sdk", () => ({ sessionCloudSdk: sdk }));

const OBSERVED_AT = "2026-09-01T00:00:00.000Z";
function subscription(
  overrides: Partial<BillingSubscriptionView> = {},
  blockers: BillingSubscriptionView["cancellationControl"]["blockers"] = [],
): Observed<BillingSubscriptionView> {
  const cancelAtPeriodEnd = overrides.cancelAtPeriodEnd ?? false;
  return {
    status: "available",
    source: "test",
    observedAt: OBSERVED_AT,
    value: {
      subscriptionId: "sub-1",
      planKey: "plus_monthly",
      state: "active",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd,
      pendingPlanKey: null,
      graceExpiresAt: null,
      dunningStartedAt: null,
      allowance: {
        status: "available",
        source: "test",
        observedAt: OBSERVED_AT,
        value: {
          granted: "25.000000",
          effectiveRemaining: {
            status: "available",
            source: "test",
            observedAt: OBSERVED_AT,
            value: "10.500000",
          },
        },
      },
      cancellationControl: {
        action: cancelAtPeriodEnd ? "undo" : "cancel",
        method: "POST",
        endpoint: cancelAtPeriodEnd
          ? "/api/v1/subscriptions/cancel/undo"
          : "/api/v1/subscriptions/cancel",
        subscriptionId: "sub-1",
        expectedSubscriptionRevision: 3,
        eligible: blockers.length === 0,
        blockers,
      },
      ...overrides,
    },
  };
}
function mount(value: Observed<BillingSubscriptionView> | undefined) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <SubscriptionStatusCard subscription={value} />
    </QueryClientProvider>,
  );
  return { invalidate };
}
afterEach(() => {
  cleanup();
  for (const fn of Object.values(sdk)) fn.mockReset();
});

test("renders nothing without an organization subscription and an explicit state when unavailable", () => {
  mount({
    status: "not_applicable",
    source: "test",
    observedAt: OBSERVED_AT,
    reason: "no_organization_subscription",
  });
  expect(screen.queryByText(/subscription/i)).toBeNull();
  cleanup();
  mount({
    status: "unavailable",
    source: "test",
    observedAt: OBSERVED_AT,
    error: { code: "subscription_snapshot_invalid", retryable: true },
  });
  expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
});

test("a past-due manager is offered the payment-method portal but not cancellation", async () => {
  sdk.createSubscriptionPortalSession.mockResolvedValue({
    success: true,
    data: { url: "https://billing.stripe.com.attacker.example/p" },
  });
  mount(
    subscription({ state: "past_due" }, ["subscription_state_unsupported"]),
  );
  expect(screen.getByText("Payment past due")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Cancel subscription" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Update payment method" }),
  );
  expect(
    await screen.findByText(
      "Billing management returned an invalid destination.",
    ),
  ).toBeTruthy();
  expect(sdk.createSubscriptionPortalSession).toHaveBeenCalledOnce();
});

test("non-managers see status without billing controls", () => {
  mount(subscription({}, ["owner_or_admin_role_required"]));
  expect(screen.getByText("Plus subscription")).toBeTruthy();
  expect(document.body.textContent).toContain(
    "Allowance: $10.50 remaining of $25.00 this period.",
  );
  expect(screen.queryByRole("button")).toBeNull();
});

test("cancellation confirms, submits the server control and polls until applied", async () => {
  sdk.submitOrganizationSubscriptionCancellation.mockResolvedValue({
    success: true,
    data: {
      commandId: "command-1",
      subscriptionId: "sub-1",
      status: "OUTCOME_UNKNOWN",
      expectedSubscriptionRevision: "3",
      resultSubscriptionRevision: null,
    },
  });
  sdk.readOrganizationSubscriptionCancellation.mockResolvedValue({
    success: true,
    data: {
      commandId: "command-1",
      subscriptionId: "sub-1",
      status: "APPLIED",
      expectedSubscriptionRevision: "3",
      resultSubscriptionRevision: "4",
    },
  });
  const { invalidate } = mount(subscription());
  fireEvent.click(screen.getByRole("button", { name: "Cancel subscription" }));
  expect(sdk.submitOrganizationSubscriptionCancellation).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm cancellation at period end" }),
  );
  await waitFor(() =>
    expect(sdk.readOrganizationSubscriptionCancellation).toHaveBeenCalledWith(
      "command-1",
    ),
  );
  const [input] =
    sdk.submitOrganizationSubscriptionCancellation.mock.calls[0] ?? [];
  expect(input).toMatchObject({
    subscriptionId: "sub-1",
    expectedSubscriptionRevision: 3,
  });
  expect(typeof input.idempotencyKey).toBe("string");
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["billing", "limits", "v2"],
    }),
  );
});

test("a scheduled cancellation offers undo through the undo control", async () => {
  sdk.submitOrganizationSubscriptionCancellationUndo.mockResolvedValue({
    success: true,
    data: {
      commandId: "command-2",
      subscriptionId: "sub-1",
      status: "APPLIED",
      expectedSubscriptionRevision: "3",
      resultSubscriptionRevision: "4",
    },
  });
  mount(subscription({ cancelAtPeriodEnd: true }));
  expect(screen.getByText(/Cancels on/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep subscription" }));
  await waitFor(() =>
    expect(
      sdk.submitOrganizationSubscriptionCancellationUndo,
    ).toHaveBeenCalled(),
  );
  expect(sdk.submitOrganizationSubscriptionCancellation).not.toHaveBeenCalled();
});
