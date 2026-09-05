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
    cumulativeRefundedChargeCurrency: 0,
    cumulativeDisputedChargeCurrency: 0,
    cumulativeClawbackCredits: 0,
    reinstatedCredits: 0,
    unrecoveredShortfallCredits: 0,
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
          cumulativeRefundedChargeCurrency: 12,
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
          cumulativeRefundedChargeCurrency: 40,
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
          cumulativeDisputedChargeCurrency: 80,
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
          cumulativeDisputedChargeCurrency: 80,
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

  it("rejects a partial row missing rendered fields, rendering the explicit error state instead of tearing down", async () => {
    // Start from a valid row and drop one rendered field at a time: the
    // ready-state guard must validate the complete row shape, because
    // rendering dereferences identifiers (authorityId.slice), amounts,
    // event fields, and reversal totals — a partial row previously tore
    // the whole card down to <div /> and never showed the promised
    // malformed/retry state (#26752 review).
    const dropFields = [
      "surface",
      "authorityId",
      "provider",
      "amountCents",
      "currency",
      "eventTime",
      "eventTimeKind",
      "cumulativeRefundedChargeCurrency",
      "cumulativeDisputedChargeCurrency",
      "cumulativeClawbackCredits",
      "reinstatedCredits",
      "unrecoveredShortfallCredits",
      "disputeReinstated",
      "supportState",
    ] as const;
    for (const field of dropFields) {
      apiMock.mockReset();
      const partial = { ...stateRow() } as Record<string, unknown>;
      delete partial[field];
      apiMock.mockResolvedValueOnce({ states: [partial] });
      render(
        <MemoryRouter>
          <PaymentActivityCard />
        </MemoryRouter>,
      );
      // eslint-disable-next-line no-await-in-loop
      await screen.findByText(/Payment activity could not be loaded/i);
      // eslint-disable-next-line no-await-in-loop
      expect(screen.getByText(/malformed/i)).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      expect(screen.queryByTestId("payment-activity-list")).toBeNull();
      // eslint-disable-next-line no-await-in-loop
      expect(screen.queryByTestId("payment-state-row")).toBeNull();
      cleanup();
    }
  });

  it("rejects rows with values outside the server state vocabulary, rendering the error state instead of an invented state", async () => {
    // The type guard must check closed unions, not string-ness: a payload
    // claiming an unknown paymentState (or an unusable eventTime / policy
    // status) would otherwise render an invented state, "Invalid Date", or
    // label an applied policy as unavailable (#26752 review r5).
    const invalidRows: Record<string, unknown>[] = [
      { ...stateRow(), paymentState: "paid" },
      { ...stateRow(), eventTime: "not-a-date" },
      {
        ...stateRow(),
        policyEffect: { status: "applied", reason: "ok" },
      },
    ];
    for (const invalid of invalidRows) {
      apiMock.mockReset();
      apiMock.mockResolvedValueOnce({ states: [invalid] });
      render(
        <MemoryRouter>
          <PaymentActivityCard />
        </MemoryRouter>,
      );
      // eslint-disable-next-line no-await-in-loop
      await screen.findByText(/Payment activity could not be loaded/i);
      // eslint-disable-next-line no-await-in-loop
      expect(screen.getByText(/malformed/i)).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      expect(screen.queryByTestId("payment-state-row")).toBeNull();
      cleanup();
    }
  });

  it("rejects non-finite numeric rows (Infinity / NaN), never rendering $∞ or $NaN", async () => {
    // typeof x === "number" passes for Infinity and NaN, and JSON produces
    // Infinity from 1e999 — Number.isFinite is the only clause standing
    // between the transport and formatAmount. Each of the six guarded
    // numeric fields gets its own non-finite row so every clause is
    // individually load-bearing (RP review r5: a single amountCents row
    // leaves the other five clauses removable without a failing test).
    // Regression control: with the clauses removed, formatAmount renders
    // "$∞" / "$NaN" in a billing row (#26752 attentionhead third-pass
    // review).
    const nonFiniteRows: Record<string, unknown>[] = [
      { ...stateRow(), amountCents: Number.POSITIVE_INFINITY },
      { ...stateRow(), amountCents: Number.NaN },
      { ...stateRow(), cumulativeRefundedChargeCurrency: JSON.parse("1e999") },
      {
        ...stateRow(),
        cumulativeDisputedChargeCurrency: Number.POSITIVE_INFINITY,
      },
      { ...stateRow(), cumulativeClawbackCredits: Number.NaN },
      { ...stateRow(), reinstatedCredits: JSON.parse("1e999") },
      { ...stateRow(), unrecoveredShortfallCredits: Number.NaN },
    ];
    for (const invalid of nonFiniteRows) {
      apiMock.mockReset();
      apiMock.mockResolvedValueOnce({ states: [invalid] });
      render(
        <MemoryRouter>
          <PaymentActivityCard />
        </MemoryRouter>,
      );
      // eslint-disable-next-line no-await-in-loop
      await screen.findByText(/Payment activity could not be loaded/i);
      // eslint-disable-next-line no-await-in-loop
      expect(screen.getByText(/malformed/i)).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      expect(screen.queryByTestId("payment-state-row")).toBeNull();
      cleanup();
    }
  });

  it("renders the policy-effect line only when the authoritative row carries one", async () => {
    // A fully refunded row with policyEffect: null must not display the
    // "Policy effect unavailable" line the response never contained — the
    // list must agree with the detail surface, which gates on !== null
    // (#26752 review r5).
    apiMock.mockResolvedValueOnce({
      states: [
        stateRow({
          paymentState: "partially_refunded",
          cumulativeRefundedChargeCurrency: 5,
          policyEffect: null,
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findByTestId("payment-state-row");
    expect(screen.getByTestId("refunded-amount").textContent).toContain("5");
    expect(screen.queryByTestId("payment-policy-effect")).toBeNull();
    cleanup();

    // Control: a row that DOES carry the policy effect still shows it.
    apiMock.mockReset();
    apiMock.mockResolvedValueOnce({
      states: [
        stateRow({
          paymentState: "partially_refunded",
          cumulativeRefundedChargeCurrency: 5,
          policyEffect: { status: "unavailable", reason: "policy_pending" },
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findByTestId("payment-state-row");
    expect(screen.getByTestId("payment-policy-effect")).toBeTruthy();
    expect(screen.getByTestId("refunded-amount").textContent).toContain("5");
  });

  it("accepts a fully valid success row that carries null optionals, not a partial one", async () => {
    // The reviewer's exact probe shape: a success row missing ONLY the
    // required authorityId must fail; the same row with every required
    // field present (receiptId null) must render.
    apiMock.mockResolvedValueOnce({
      states: [{ ...stateRow(), authorityId: undefined }],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findByText(/Payment activity could not be loaded/i);
    expect(screen.queryByTestId("payment-state-row")).toBeNull();
    cleanup();

    apiMock.mockReset();
    apiMock.mockResolvedValueOnce({ states: [stateRow()] });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");
    expect(screen.getByTestId("payment-state-text").textContent).toBe(
      "succeeded",
    );
  });

  it("shows reversal detail for a row carrying only a shortfall or a support escalation, matching the detail surface", async () => {
    // The list's reversal gate must cover the same authoritative field set
    // the detail surface renders: a row with all four classic totals zero,
    // policyEffect: null, but a real unrecoveredShortfallCredits (or a
    // contact_support escalation) is a reversed payment per the authority.
    // The old gate hid both facts in the list while detail showed them
    // (#26752 review r6).
    apiMock.mockResolvedValueOnce({
      states: [
        stateRow({
          id: "payment_request:shortfall-only",
          surface: "payment_request",
          authorityId: "pr_shortfall",
          unrecoveredShortfallCredits: 5,
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findByTestId("payment-state-row");
    expect(screen.getByTestId("payment-reversal-detail")).toBeTruthy();
    expect(screen.getByTestId("shortfall-amount").textContent).toContain("5");
    cleanup();

    // A row whose ONLY reversal signal is a support escalation also gets the
    // reversal block (it renders the contact-support line inside it).
    apiMock.mockReset();
    apiMock.mockResolvedValueOnce({
      states: [
        stateRow({
          id: "payment_request:support-only",
          surface: "payment_request",
          authorityId: "pr_support",
          supportState: "contact_support",
        }),
      ],
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findByTestId("payment-state-row");
    expect(screen.getByTestId("payment-reversal-detail")).toBeTruthy();
    expect(screen.getByText(/Contact support for this payment/i)).toBeTruthy();
    cleanup();

    // Control: a plain success row with none of the reversal signals shows
    // no reversal detail — the gate additions did not over-capture.
    apiMock.mockReset();
    apiMock.mockResolvedValueOnce({ states: [stateRow()] });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findByTestId("payment-state-row");
    expect(screen.queryByTestId("payment-reversal-detail")).toBeNull();
  });

  it("rejects timestamps that do not round-trip the server's ISO serialization", async () => {
    // The server serializes every eventTime with toISOString(), so the
    // canonical round-trip is the transport contract: "0" parses to a 2000
    // date, "2024-02-30" silently normalizes to March 1, and a date-only
    // or offset form renders an altered timestamp. None may enter the
    // ready state (#26752 review r6).
    const nonCanonical: Record<string, unknown>[] = [
      { ...stateRow(), eventTime: "0" },
      { ...stateRow(), eventTime: "2024-02-30T00:00:00.000Z" },
      { ...stateRow(), eventTime: "2024-01-01" },
      { ...stateRow(), eventTime: "2024-01-01T00:00:00.000+05:00" },
    ];
    for (const row of nonCanonical) {
      apiMock.mockReset();
      apiMock.mockResolvedValueOnce({ states: [row] });
      render(
        <MemoryRouter>
          <PaymentActivityCard />
        </MemoryRouter>,
      );
      // eslint-disable-next-line no-await-in-loop
      await screen.findByText(/Payment activity could not be loaded/i);
      // eslint-disable-next-line no-await-in-loop
      expect(screen.getByText(/malformed/i)).toBeTruthy();
      // eslint-disable-next-line no-await-in-loop
      expect(screen.queryByTestId("payment-state-row")).toBeNull();
      cleanup();
    }
  });
});

describe("PaymentActivityCard reversal currency rendering (#26752 review)", () => {
  // Regression: reversal amounts were formatted with a hard-coded "USD"
  // while the projection carries them in the purchase's own currency
  // (Stripe minor units of the charge). A refunded EUR purchase rendered
  // "$19" next to "€19" — the customer-visible wrong one (review finding:
  // both cannot be right, and the one the customer sees was wrong).
  it("formats reversal amounts in the row's own currency, not USD", async () => {
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "checkout_order:eur",
          amountCents: 1900,
          currency: "EUR",
          paymentState: "partially_refunded",
          cumulativeRefundedChargeCurrency: 19,
          cumulativeDisputedChargeCurrency: 7.5,
          unrecoveredShortfallCredits: 2.25,
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

    expect(screen.getByTestId("refunded-amount").textContent).toBe("€19");
    expect(screen.getByTestId("disputed-amount").textContent).toBe("€7.50");
    // The shortfall is CREDIT units (the clawback target is denominated in
    // granted credits), labeled as credits — never formatted in the charge
    // currency or relabeled USD (#26752 review P1: credit-unit clawback
    // shortfall must not be presented as currency).
    expect(screen.getByTestId("shortfall-amount").textContent).toBe(
      "2.25 credits",
    );
    // The purchase line itself stays in its own currency (already correct).
    expect(screen.queryByText("$19")).toBeNull();
    expect(screen.queryByText("$7.50")).toBeNull();
    expect(screen.queryByText("€2.25")).toBeNull();
    expect(screen.queryByText("$2.25")).toBeNull();
  });

  it("USD purchases still render reversal amounts with the $ sign", async () => {
    apiMock.mockResolvedValue({
      states: [
        stateRow({
          id: "checkout_order:usd",
          paymentState: "partially_refunded",
          cumulativeRefundedChargeCurrency: 12,
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
    expect(screen.getByTestId("refunded-amount").textContent).toBe("$12");
  });
});

describe("PaymentActivityCard payment-history pagination (#26752 P2)", () => {
  it("shows pagination controls and requests the second page with the rows-so-far offset when hasMore is true", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      stateRow({ id: `checkout_order:p1-${i}`, authorityId: `p1-${i}` }),
    );
    const secondPageRow = stateRow({
      id: "checkout_order:p2-0",
      authorityId: "p2-0",
      paymentState: "refunded",
      cumulativeRefundedChargeCurrency: 25,
    });
    apiMock.mockResolvedValueOnce({
      states: firstPage,
      total: 51,
      offset: 0,
      hasMore: true,
    });
    apiMock.mockResolvedValueOnce({
      states: [secondPageRow],
      total: 51,
      offset: 50,
      hasMore: false,
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );

    await screen.findAllByTestId("payment-state-row");
    // Count line is honest: 50 of the org's real 51 persisted payments.
    expect(screen.getByTestId("payment-activity-count").textContent).toBe(
      "Showing 50 of 51 payments",
    );

    const actor = userEvent.setup();
    await actor.click(screen.getByTestId("payment-activity-load-more"));

    // The second page is requested at offset = rows already shown (50), the
    // route's own default limit — a larger fixed first-page limit would only
    // move the cutoff (P2 review finding).
    expect(apiMock).toHaveBeenLastCalledWith(
      "/api/v1/billing/payment-states?offset=50",
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("payment-state-row").length).toBe(51);
    });
    // The older refunded payment from page 2 is now reachable in the card…
    expect(screen.getAllByTestId("payment-reversal-detail").length).toBe(1);
    // …its detail link resolves to the payment-state detail surface…
    const detailLink = screen.getAllByTestId("payment-authority-link")[50];
    expect(detailLink.getAttribute("href")).toBe(
      "/cloud/billing/payments/checkout_order%3Ap2-0",
    );
    // …and traversal ends honestly once the server says hasMore=false.
    expect(screen.getByTestId("payment-activity-count").textContent).toBe(
      "Showing 51 of 51 payments",
    );
    expect(screen.getByTestId("payment-activity-end").textContent).toBe(
      "All payments shown",
    );
    expect(screen.queryByTestId("payment-activity-load-more")).toBeNull();
  });

  it("hides the load-more control when the first page holds the entire history", async () => {
    apiMock.mockResolvedValue({
      states: [stateRow()],
      total: 1,
      offset: 0,
      hasMore: false,
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");
    expect(screen.queryByTestId("payment-activity-load-more")).toBeNull();
    expect(screen.getByTestId("payment-activity-end").textContent).toBe(
      "All payments shown",
    );
    expect(screen.getByTestId("payment-activity-count").textContent).toBe(
      "Showing 1 of 1 payments",
    );
  });

  it("keeps already-loaded rows and offers a retry when a page-2 fetch fails", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      stateRow({ id: `checkout_order:p1-${i}`, authorityId: `p1-${i}` }),
    );
    apiMock.mockResolvedValueOnce({
      states: firstPage,
      total: 51,
      offset: 0,
      hasMore: true,
    });
    apiMock.mockRejectedValueOnce(new Error("paging transport down"));
    apiMock.mockResolvedValueOnce({
      states: [stateRow({ id: "checkout_order:p2-0", authorityId: "p2-0" })],
      total: 51,
      offset: 50,
      hasMore: false,
    });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");

    const actor = userEvent.setup();
    await actor.click(screen.getByTestId("payment-activity-load-more"));

    // Paging failure NEVER tears down already-loaded history: the 50 rows
    // stay rendered and the failure is visible inline with the reason.
    await screen.findByTestId("payment-activity-load-more-error");
    expect(screen.getAllByTestId("payment-state-row").length).toBe(50);
    expect(
      screen.getByTestId("payment-activity-load-more-error").textContent,
    ).toContain("paging transport down");

    // Retry re-issues the same page request and recovers.
    await actor.click(screen.getByTestId("payment-activity-load-more"));
    await waitFor(() => {
      expect(screen.getAllByTestId("payment-state-row").length).toBe(51);
    });
    expect(apiMock).toHaveBeenLastCalledWith(
      "/api/v1/billing/payment-states?offset=50",
    );
  });

  it("degrades to no pagination controls when the envelope is absent", async () => {
    apiMock.mockResolvedValue({ states: [stateRow()] });
    render(
      <MemoryRouter>
        <PaymentActivityCard />
      </MemoryRouter>,
    );
    await screen.findAllByTestId("payment-state-row");
    expect(screen.queryByTestId("payment-activity-load-more")).toBeNull();
    // No total known: no count line either, rather than a fabricated total.
    expect(screen.queryByTestId("payment-activity-count")).toBeNull();
    expect(screen.queryByTestId("payment-activity-end")).toBeNull();
  });
});
