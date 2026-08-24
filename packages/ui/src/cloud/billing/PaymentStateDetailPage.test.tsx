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
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
        cumulativeRefundedUsd: 12,
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
