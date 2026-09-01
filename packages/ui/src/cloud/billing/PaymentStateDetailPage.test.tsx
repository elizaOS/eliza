/**
 * Payment state detail page contract tests (#22966 linked order/receipt
 * surface): distinct loading / not-found / error-with-retry / success
 * states, full identifier display with copy support, reversal detail
 * rendering, and never-client-derived status. Harness is deterministic
 * jsdom with a mocked transport (the server derivation is proven by the
 * pglite service suite and the route-level tests).
 */

// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return {
    api: vi.fn(),
    MockApiError,
  };
});
const { MockApiError } = apiMock;

vi.mock("../lib/api-client", () => ({
  api: (...args: unknown[]) => apiMock.api(...args),
  // Referenced lazily via the hoisted container — the factory is hoisted
  // above the const destructure, so it must not close over MockApiError
  // directly.
  ApiError: apiMock.MockApiError,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      opts?: { defaultValue?: string } & Record<string, unknown>,
    ): string => {
      const template = opts?.defaultValue ?? _key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(opts?.[name] ?? ""),
      );
    },
}));

import type { PaymentStateDisplay } from "./components/payment-activity-card";
import PaymentStateDetailPage from "./PaymentStateDetailPage";

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

function renderDetail(id = "checkout_order:o1") {
  return render(
    <MemoryRouter
      initialEntries={[`/cloud/billing/payments/${encodeURIComponent(id)}`]}
    >
      <Routes>
        <Route
          path="/cloud/billing/payments/:id"
          element={<PaymentStateDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.api.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PaymentStateDetailPage fetch states", () => {
  it("renders the loading state before data arrives", async () => {
    apiMock.api.mockImplementation(() => new Promise(() => {}));
    renderDetail();
    // Loading is a visible skeleton with an accessible status label — never
    // a blank page.
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("Loading payment detail");
    // The fetch is scheduled via queueMicrotask — wait for it to start while
    // the pending promise keeps the loading state rendered.
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(
        "/api/v1/billing/payment-states/checkout_order%3Ao1",
      ),
    );
  });

  it("renders a distinct not-found state on 404", async () => {
    apiMock.api.mockRejectedValueOnce(
      new MockApiError(
        404,
        "PAYMENT_STATE_NOT_FOUND",
        "Request failed with status 404",
      ),
    );
    renderDetail();
    await screen.findByTestId("payment-detail-not-found");
    expect(screen.getByText(/This payment could not be found/i)).toBeTruthy();
  });

  it("renders an explicit error state with retry after transport failure", async () => {
    apiMock.api.mockRejectedValueOnce(new Error("network down"));
    apiMock.api.mockResolvedValueOnce({ state: stateRow() });
    renderDetail();

    await screen.findByTestId("payment-detail-error");
    expect(screen.getByText("network down")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await screen.findByTestId("payment-detail-title");
    expect(apiMock.api).toHaveBeenCalledTimes(2);
  });

  it("renders an error state on a malformed success payload", async () => {
    apiMock.api.mockResolvedValueOnce({ unrelated: true });
    renderDetail();
    await screen.findByTestId("payment-detail-error");
    expect(screen.getByText(/malformed/i)).toBeTruthy();
  });

  it("rejects a partial row missing rendered fields, never rendering fabricated values", async () => {
    // Start from a valid row and drop one rendered field at a time: a
    // payload missing amount, currency, identifiers, event fields, or
    // reversal totals must fail validation — a fabricated-success render
    // (NaN amount, invalid date, invented policy effect) is the failure
    // this guard exists to prevent (#22966 review r4).
    const dropFields = [
      "amountCents",
      "currency",
      "authorityId",
      "eventTime",
      "eventTimeKind",
      "cumulativeRefundedChargeCurrency",
      "supportState",
      "disputeReinstated",
    ] as const;
    for (const field of dropFields) {
      apiMock.api.mockReset();
      const partial = { ...stateRow() } as Record<string, unknown>;
      delete partial[field];
      apiMock.api.mockResolvedValueOnce({ state: partial });
      renderDetail();
      // eslint-disable-next-line no-await-in-loop
      await screen.findByTestId("payment-detail-error");
      expect(screen.getByText(/malformed/i)).toBeTruthy();
      expect(screen.queryByTestId("payment-detail-title")).toBeNull();
      cleanup();
    }
  });

  it("rejects a success row with a non-finite amount, never rendering $∞ / $NaN", async () => {
    // typeof x === "number" passes for Infinity and NaN, and JSON produces
    // Infinity from 1e999 — Number.isFinite is the only clause between the
    // transport and the rendered amount. The list-surface suite pins each
    // of the six guarded numeric fields individually; this detail-surface
    // test covers the rendered amount path (attentionhead third-pass
    // review of #26752).
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({ amountCents: Number.POSITIVE_INFINITY }),
    });
    renderDetail();
    await screen.findByTestId("payment-detail-error");
    expect(screen.getByText(/malformed/i)).toBeTruthy();
    expect(screen.queryByTestId("payment-detail-title")).toBeNull();
  });

  it("rejects a success row whose id does not match the active route id", async () => {
    // The route contract binds /payments/:id to the requested row: a
    // well-formed payload for a DIFFERENT payment must not render as this
    // route's success state (#26752 review P2).
    apiMock.api.mockResolvedValueOnce({ state: stateRow() });
    renderDetail("checkout_order:other");
    await screen.findByTestId("payment-detail-error");
    expect(screen.getByText(/malformed/i)).toBeTruthy();
    expect(screen.queryByTestId("payment-detail-title")).toBeNull();
  });

  it("a delayed response for a previous route id never overwrites the current row (#26752 P2)", async () => {
    // Deferred A/B navigation: fetch A (slow) then navigate to B (fast) —
    // the SAME mounted component with a new :id param, exactly like the
    // app's route. The old unguarded completion order let A's
    // amount/receipt/authority render on /payments/B. The generation guard
    // must reject A's late completion.
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              navigate("/cloud/billing/payments/checkout_order:b1")
            }
          >
            go-b
          </button>
          <Routes>
            <Route
              path="/cloud/billing/payments/:id"
              element={<PaymentStateDetailPage />}
            />
          </Routes>
        </>
      );
    }

    let resolveA: (value: unknown) => void = () => {};
    const fetchA = new Promise((resolve) => {
      resolveA = resolve;
    });
    apiMock.api.mockImplementationOnce(() => fetchA);
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({
        id: "checkout_order:b1",
        authorityId: "authority-B",
        amountCents: 9900,
      }),
    });

    render(
      <MemoryRouter
        initialEntries={["/cloud/billing/payments/checkout_order:a1"]}
      >
        <Harness />
      </MemoryRouter>,
    );

    // A's fetch started; navigate to B before it completes.
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(
        "/api/v1/billing/payment-states/checkout_order%3Aa1",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "go-b" }));

    await screen.findByTestId("payment-detail-title");
    expect(screen.getByTestId("payment-detail-authority").textContent).toBe(
      "authority-B",
    );

    // A's delayed completion arrives AFTER B rendered successfully.
    resolveA({
      state: stateRow({
        id: "checkout_order:a1",
        authorityId: "authority-A",
        amountCents: 1100,
      }),
    });
    // Let A's stale continuation run; the rendered row must still be B's.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("payment-detail-authority").textContent).toBe(
      "authority-B",
    );
    expect(screen.queryByText("authority-A")).toBeNull();
  });

  it("first commit for the new route id is loading with no stale authority row (#26752 P2)", async () => {
    // Layout-effect regression requested by review: resolve A, hold B
    // pending, navigate A→B, and assert the FIRST commit rendered for B
    // has no authority row and is loading — not ready(A) reused under the
    // B URL. React re-renders the same mounted component with the new id
    // BEFORE the new fetch's passive effect starts, so without the
    // requestedId guard the old ready(A) phase renders under /payments/B.
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              navigate("/cloud/billing/payments/checkout_order:b3")
            }
          >
            go-b
          </button>
          <Routes>
            <Route
              path="/cloud/billing/payments/:id"
              element={<PaymentStateDetailPage />}
            />
          </Routes>
        </>
      );
    }

    // A resolves; B stays pending forever.
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({
        id: "checkout_order:a3",
        authorityId: "authority-A3",
        amountCents: 1100,
      }),
    });
    apiMock.api.mockImplementationOnce(() => new Promise(() => {}));

    render(
      <MemoryRouter
        initialEntries={["/cloud/billing/payments/checkout_order:a3"]}
      >
        <Harness />
      </MemoryRouter>,
    );

    // A is resolved and rendered.
    await screen.findByTestId("payment-detail-title");
    expect(screen.getByTestId("payment-detail-authority").textContent).toBe(
      "authority-A3",
    );

    // Navigate to B; synchronously after the route commit, the rendered
    // surface must already be loading-for-B with no A authority present.
    fireEvent.click(screen.getByRole("button", { name: "go-b" }));
    // The click handler runs navigate() synchronously; React commits the
    // re-render before yielding, so the assertions below observe the first
    // B commit without awaiting any timer or fetch.
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Loading payment detail",
    );
    expect(screen.queryByTestId("payment-detail-authority")).toBeNull();
    expect(screen.queryByTestId("payment-detail-title")).toBeNull();
    expect(screen.queryByText("authority-A3")).toBeNull();
    expect(screen.queryByTestId("payment-detail-error")).toBeNull();
    expect(screen.queryByTestId("payment-detail-not-found")).toBeNull();
  });

  it("a stale error state for a previous route id never renders under the new id (#26752 P2)", async () => {
    // The identity guard must cover EVERY phase kind, not just ready: A's
    // malformed-payload error must degrade to loading-for-B on the first B
    // commit, never render A's error text under /payments/B.
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              navigate("/cloud/billing/payments/checkout_order:b4")
            }
          >
            go-b
          </button>
          <Routes>
            <Route
              path="/cloud/billing/payments/:id"
              element={<PaymentStateDetailPage />}
            />
          </Routes>
        </>
      );
    }

    // A fails with a malformed payload; B stays pending forever.
    apiMock.api.mockResolvedValueOnce({ unrelated: true });
    apiMock.api.mockImplementationOnce(() => new Promise(() => {}));

    render(
      <MemoryRouter
        initialEntries={["/cloud/billing/payments/checkout_order:a4"]}
      >
        <Harness />
      </MemoryRouter>,
    );

    // A's error state is rendered.
    await screen.findByTestId("payment-detail-error");

    // Navigate to B: the first B commit must be loading, not A's error.
    fireEvent.click(screen.getByRole("button", { name: "go-b" }));
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Loading payment detail",
    );
    expect(screen.queryByTestId("payment-detail-error")).toBeNull();
    expect(screen.queryByText(/malformed/i)).toBeNull();
  });

  it("a delayed failure for a previous route id never overwrites the current row (#26752 P2)", async () => {
    // Same generation guard on the catch path: a stale rejection must not
    // tear down the newer route's rendered row.
    function Harness() {
      const navigate = useNavigate();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              navigate("/cloud/billing/payments/checkout_order:b2")
            }
          >
            go-b
          </button>
          <Routes>
            <Route
              path="/cloud/billing/payments/:id"
              element={<PaymentStateDetailPage />}
            />
          </Routes>
        </>
      );
    }

    let rejectA: (reason?: unknown) => void = () => {};
    const fetchA = new Promise((_resolve, reject) => {
      rejectA = reject;
    });
    apiMock.api.mockImplementationOnce(() => fetchA);
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({
        id: "checkout_order:b2",
        authorityId: "authority-B2",
      }),
    });

    render(
      <MemoryRouter
        initialEntries={["/cloud/billing/payments/checkout_order:a2"]}
      >
        <Harness />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(
        "/api/v1/billing/payment-states/checkout_order%3Aa2",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "go-b" }));
    await screen.findByTestId("payment-detail-title");

    rejectA(new Error("stale route failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("payment-detail-authority").textContent).toBe(
      "authority-B2",
    );
    expect(screen.queryByTestId("payment-detail-error")).toBeNull();
  });
});

describe("PaymentStateDetailPage success rendering", () => {
  it("shows the full row: state, amount, provider, event time kind, and full identifiers", async () => {
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({
        id: "payment_request:pr1",
        surface: "payment_request",
        authorityId: "authority-uuid-1",
        receiptId: "receipt-uuid-1",
        amountCents: 12345,
        eventTimeKind: "reversal_ledger_observation",
      }),
    });
    renderDetail("payment_request:pr1");

    await screen.findByTestId("payment-detail-title");
    expect(screen.getByTestId("payment-detail-state").textContent).toBe(
      "succeeded",
    );
    expect(screen.getAllByText("$123.45").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reversal observed/i).length).toBe(1);

    // Full identifiers — not truncated to 8 chars like the list rows.
    expect(screen.getByTestId("payment-detail-authority").textContent).toBe(
      "authority-uuid-1",
    );
    expect(screen.getByTestId("payment-detail-receipt").textContent).toBe(
      "receipt-uuid-1",
    );
  });

  it("shows the honest no-receipt state instead of a fabricated receipt", async () => {
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({ receiptId: null }),
    });
    renderDetail();
    await screen.findByTestId("payment-detail-receipt-none");
    expect(
      screen.getByText(/No provider-neutral receipt projected/i),
    ).toBeTruthy();
  });

  it("copies the full authority and receipt identifiers from the detail view", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({
        id: "payment_request:pr2",
        surface: "payment_request",
        authorityId: "authority-uuid-2",
        receiptId: "receipt-uuid-2",
      }),
    });
    renderDetail("payment_request:pr2");

    await screen.findByTestId("payment-detail-receipt");
    // fireEvent: userEvent's pointer simulation swallows clicks on inline
    // buttons in this jsdom harness (list-card probe-proven behavior).
    fireEvent.click(screen.getByTestId("payment-detail-authority"));
    fireEvent.click(screen.getByTestId("payment-detail-receipt"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(1, "authority-uuid-2");
    expect(writeText).toHaveBeenNthCalledWith(2, "receipt-uuid-2");
  });

  it("renders reversal totals, credit-unit labels, and policy effect for a refunded row", async () => {
    apiMock.api.mockResolvedValueOnce({
      state: stateRow({
        paymentState: "partially_refunded",
        cumulativeRefundedChargeCurrency: 12,
        cumulativeClawbackCredits: 12,
        policyEffect: {
          status: "unavailable",
          reason: "refund_entitlement_policy_pending_22930",
        },
        supportState: "contact_support",
      }),
    });
    renderDetail();

    await screen.findByTestId("payment-detail-reversal");
    expect(screen.getByTestId("payment-detail-refunded").textContent).toBe(
      "$12",
    );
    expect(screen.getByTestId("payment-detail-clawback").textContent).toBe(
      "12.00 credits",
    );
    expect(
      screen.getByTestId("payment-detail-policy-effect").textContent,
    ).toMatch(/Policy effect unavailable/i);
    expect(screen.getByText(/Contact support/i)).toBeTruthy();
  });

  it("omits the reversal section for plain succeeded rows", async () => {
    apiMock.api.mockResolvedValueOnce({ state: stateRow() });
    renderDetail();
    await screen.findByTestId("payment-detail-title");
    expect(screen.queryByTestId("payment-detail-reversal")).toBeNull();
  });
});
