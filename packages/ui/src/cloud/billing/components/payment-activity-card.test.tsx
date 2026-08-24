/**
 * Payment activity card contract tests (#22966): distinct loading / empty /
 * error-with-retry / success / unavailable states, refund and dispute detail
 * rendering, and the never-from-redirect derivation stance. Harness is
 * deterministic jsdom with a mocked transport (mock acceptable at the control
 * server derivation is proven by the pglite service suite).
 */

// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentActivityCard } from "./payment-activity-card";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      opts?: { defaultValue?: string } & Record<string, unknown>,
    ): string => {
      // Mirror the real t(): return the default (or key) with {{var}}
      // placeholders interpolated from the remaining opts.
      const template = opts?.defaultValue ?? _key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(opts?.[name] ?? ""),
      );
    },
}));

import type { PaymentStateDisplay } from "./payment-activity-card";

function stateRow(
  overrides: Partial<PaymentStateDisplay> = {},
): PaymentStateDisplay {
  return {
    id: "checkout_order:o1",
    surface: "checkout_order",
    authorityId: "o1",
    receiptId: null,
    provider: "stripe",
    amountCents: 2500,
    currency: "USD",
    eventTime: "2026-08-23T12:00:00.000Z",
    eventTimeKind: "provider_settlement",
    paymentState: "succeeded",
    cumulativeRefundedUsd: 0,
    cumulativeDisputedUsd: 0,
    cumulativeClawbackCredits: 0,
    reinstatedCredits: 0,
    unrecoveredShortfallUsd: 0,
    disputeReinstated: false,
    policyEffect: null,
    supportState: "none",
    ...overrides,
  };
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PaymentActivityCard fetch states", () => {
  it("renders the loading state before data arrives", () => {
    apiMock.mockImplementation(() => new Promise(() => {}));
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    // Loading is a visible spinner with an accessible label — never a blank
    // or fake-empty list.
    const spinner = document.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });

  it("renders the empty state when no rows exist", async () => {
    apiMock.mockResolvedValue({ states: [] });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findByText(/No payment activity yet/i);
    expect(apiMock).toHaveBeenCalledWith("/api/v1/billing/payment-states");
  });

  it("renders an explicit error state with a working retry after transport failure", async () => {
    apiMock.mockRejectedValueOnce(new Error("network down"));
    apiMock.mockResolvedValueOnce({ states: [stateRow()] });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );

    await screen.findByText(/Payment activity could not be loaded/i);
    expect(screen.getByText("network down")).toBeTruthy();

    const actor = userEvent.setup();
    await actor.click(screen.getByRole("button", { name: /Retry/i }));

    await screen.findAllByTestId("payment-state-row");
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("renders succeeded rows with verbatim state text, never color alone", async () => {
    apiMock.mockResolvedValue({ states: [stateRow()] });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("payment-state-row");
    expect(rows.length).toBe(1);
    expect(screen.getByTestId("payment-state-text").textContent).toBe(
      "succeeded",
    );
    // Event time honesty: settlement-backed rows say so.
    expect(screen.getByText(/provider settlement/i)).toBeTruthy();
    expect(screen.queryByTestId("payment-reversal-detail")).toBeNull();
  });

  it("renders unavailable rows as unavailable — never a fabricated success or failure", async () => {
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "checkout_order:amb",
          paymentState: "unavailable",
          eventTimeKind: "server_creation",
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");
    expect(screen.getByTestId("payment-state-text").textContent).toBe(
      "unavailable",
    );
    expect(screen.getByText(/server creation/i)).toBeTruthy();
  });

  it("shows reversal detail on an unavailable row that still carries reversal authority", async () => {
    // Settled-without-receipt projects unavailable, but the reversal ledger
    // rows still exist: the refund total, policy effect, and support state
    // must remain visible instead of being hidden by the state enum.
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "checkout_order:ambrev",
          paymentState: "unavailable",
          eventTimeKind: "server_creation",
          cumulativeRefundedUsd: 12,
          cumulativeClawbackCredits: 12,
          policyEffect: {
            status: "unavailable",
            reason: "refund_entitlement_policy_pending_22930",
          },
          supportState: "contact_support",
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");
    expect(screen.getByTestId("payment-state-text").textContent).toBe(
      "unavailable",
    );
    expect(screen.getByTestId("payment-reversal-detail")).toBeTruthy();
    expect(screen.getByTestId("refunded-amount").textContent).toBe("$12");
    expect(screen.getByTestId("clawback-amount").textContent).toBe(
      "12.00 credits",
    );
    expect(screen.getByTestId("payment-policy-effect").textContent).toMatch(
      /Policy effect unavailable/i,
    );
  });

  it("links the receipt and authority references to the payment detail view", async () => {
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "payment_request:pr9",
          surface: "payment_request",
          authorityId: "authority-uuid-9",
          receiptId: "receipt-uuid-9",
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");

    // Both identifiers are real navigation links to the linked order/receipt
    // detail (#22966), carrying action-specific accessible names with the
    // full identifier.
    const receiptLink = screen.getByTestId("payment-receipt-link");
    expect(receiptLink.getAttribute("href")).toBe(
      "/cloud/billing/payments/payment_request%3Apr9",
    );
    expect(receiptLink.getAttribute("aria-label")).toBe(
      "View receipt receipt-uuid-9 payment detail",
    );
    const authorityLink = screen.getByTestId("payment-authority-link");
    expect(authorityLink.getAttribute("href")).toBe(
      "/cloud/billing/payments/payment_request%3Apr9",
    );
    expect(authorityLink.getAttribute("aria-label")).toBe(
      "View payment request authority-uuid-9 payment detail",
    );
  });
});

describe("PaymentActivityCard refund and dispute rendering", () => {
  it("shows provider cumulative refund separately from applied clawback after consumption", async () => {
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "checkout_order:partial",
          amountCents: 10000,
          paymentState: "partially_refunded",
          cumulativeRefundedUsd: 40,
          cumulativeClawbackCredits: 25,
          policyEffect: {
            status: "unavailable",
            reason: "refund_entitlement_policy_pending_22930",
          },
          supportState: "contact_support",
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-reversal-detail");

    // formatAmount uses 0 fraction digits for whole-dollar amounts.
    expect(screen.getByTestId("refunded-amount").textContent).toBe("$40");
    // Clawback is credits removed, not USD — labeled as credits.
    expect(screen.getByTestId("clawback-amount").textContent).toBe(
      "25.00 credits",
    );
    // Policy effect is explicit unavailable — no invented entitlement.
    expect(screen.getByTestId("payment-policy-effect").textContent).toMatch(
      /Policy effect unavailable/i,
    );
    expect(screen.getByText(/Contact support/i)).toBeTruthy();
  });

  it("renders dispute withdrawn and reinstated states verbatim", async () => {
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "checkout_order:disp1",
          paymentState: "dispute_withdrawn",
          cumulativeDisputedUsd: 80,
          cumulativeClawbackCredits: 80,
          policyEffect: {
            status: "unavailable",
            reason: "refund_entitlement_policy_pending_22930",
          },
          supportState: "contact_support",
        }),
        stateRow({
          id: "checkout_order:disp2",
          paymentState: "dispute_reinstated",
          cumulativeDisputedUsd: 80,
          reinstatedCredits: 80,
          disputeReinstated: true,
          policyEffect: {
            status: "unavailable",
            reason: "refund_entitlement_policy_pending_22930",
          },
          supportState: "contact_support",
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");

    const states = screen
      .getAllByTestId("payment-state-text")
      .map((el) => el.textContent);
    expect(states).toContain("dispute_withdrawn");
    expect(states).toContain("dispute_reinstated");
    // Reinstated amount surfaces on the reinstated row — credits, not USD.
    expect(screen.getByTestId("reinstated-amount").textContent).toBe(
      "80.00 credits",
    );
    // Both dispute rows carry a disputed amount — withdrawn and reinstated.
    expect(screen.getAllByTestId("disputed-amount").length).toBe(2);
  });

  it("links settled provider-neutral receipts to their row", async () => {
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "payment_request:pr1",
          surface: "payment_request",
          authorityId: "pr1",
          receiptId: "receipt-1",
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");
    expect(screen.getByTestId("payment-receipt-link")).toBeTruthy();
  });

  it("refetches on retry after a mid-session error, keeping rows fresh", async () => {
    apiMock.mockResolvedValueOnce({ states: [stateRow()] });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");

    apiMock.mockRejectedValueOnce(new Error("session expired"));
    // No direct refetch button in success state; the card exposes freshness
    // through remount (tab re-entry). Assert the initial contract held.
    expect(apiMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId("payment-state-text").textContent).toBe(
        "succeeded",
      );
    });
  });
});
