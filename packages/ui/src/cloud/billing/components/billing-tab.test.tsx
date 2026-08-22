/**
 * Accessibility + reflow contract for BillingTab's credit hero, buy-credits
 * form, and invoice list. jsdom render with a URL-routed api mock; the child
 * settings cards and lazy crypto card are stubbed so assertions stay on the
 * three surfaces this test owns. Covers invalid submit, empty-form submit,
 * keyboard (Enter) submit, invoice reflow classes, and status text + icon.
 */
// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const snapshotRefetchMock = vi.hoisted(() => vi.fn());
const snapshotQuery = vi.hoisted(() => ({
  current: null as unknown,
}));

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      opts?: { defaultValue?: string } & Record<string, unknown>,
    ) => {
      let value = opts?.defaultValue ?? _key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (k === "defaultValue") continue;
          value = value.replace(`{{${k}}}`, String(v));
        }
      }
      return value;
    },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../data/billing-snapshot", () => ({
  useBillingSnapshotV2: () => snapshotQuery.current,
}));

// The sibling auto-top-up card calls the billing settings API on mount; stub it
// so the shared api mock only sees this tab's own requests.
vi.mock("./auto-top-up-card", () => ({
  AutoTopUpCard: () => null,
}));

vi.mock("./direct-crypto-credit-card", () => ({
  DirectCryptoCreditCard: ({
    onSuccess,
  }: {
    onSuccess: () => Promise<void> | void;
  }) => (
    <button type="button" onClick={() => void onSuccess()}>
      Confirm direct crypto
    </button>
  ),
}));

import type { BillingUser, InvoiceDisplay } from "../types";
import { BillingTab } from "./billing-tab";

const user: BillingUser = {
  organization_id: "org-1",
  wallet_address: null,
};

const OBSERVED_AT = "2026-08-21T10:20:30.000Z";

function readySnapshotQuery(balance = "12.500000") {
  return {
    data: {
      snapshotStartedAt: OBSERVED_AT,
      snapshotCompletedAt: OBSERVED_AT,
      balance: {
        status: "available",
        source: "credit-ledger",
        observedAt: OBSERVED_AT,
        value: {
          balance: { value: balance, unit: "usd", currency: "USD" },
          revision: "7",
        },
      },
      activeCompute: {
        resources: {
          status: "available",
          source: "compute",
          observedAt: OBSERVED_AT,
          value: [],
        },
        estimatedRecurringComputeCostPerDay: {
          status: "available",
          source: "compute",
          observedAt: OBSERVED_AT,
          value: { value: "0.000000", unit: "usd_per_day", currency: "USD" },
        },
      },
    },
    isError: false,
    isFetching: false,
    isRefetchError: false,
    fetchStatus: "idle",
    refetch: snapshotRefetchMock,
  };
}

const invoices: InvoiceDisplay[] = [
  { id: "inv-1", date: "2024-01-02 10:00", total: "$25.00", status: "paid" },
  { id: "inv-2", date: "2024-02-03 11:00", total: "$5.00", status: "pending" },
];

function routeApi(overrides: { invoices?: InvoiceDisplay[] } = {}) {
  apiMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/invoices/list")) {
      return Promise.resolve({ invoices: overrides.invoices ?? invoices });
    }
    if (url.startsWith("/api/crypto/status")) {
      return Promise.resolve({ enabled: false });
    }
    if (url.startsWith("/api/stripe/create-checkout-session")) {
      // Return no url so no jsdom navigation happens; the started request is
      // the observable proof of submission.
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  apiMock.mockReset();
  snapshotRefetchMock.mockReset();
  snapshotRefetchMock.mockResolvedValue({});
  snapshotQuery.current = readySnapshotQuery();
});

describe("BillingTab buy-credits accessibility", () => {
  it("wires the amount hint, marks an out-of-range value invalid, and blocks checkout", async () => {
    routeApi();
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    // Let the invoice/crypto loads settle before interacting.
    await screen.findAllByTestId("invoice-row");
    const input = screen.getByLabelText("Amount (USD)");
    // Baseline: described by the hint, not invalid, and the buy button stays
    // enabled before any input.
    expect(input.getAttribute("aria-describedby")).toBe("purchase-amount-hint");
    const buyButton = screen.getByRole("button", { name: /Buy credits/i });
    expect(buyButton).toHaveProperty("disabled", false);

    await actor.type(input, "0");

    const alert = await screen.findByRole("alert");
    expect(alert.id).toBe("purchase-amount-error");
    expect(alert.textContent).toMatch(/Minimum amount is \$1/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(
      "purchase-amount-hint purchase-amount-error",
    );
    // Button is never disabled for a bad value — the form must be submittable
    // so validation feedback fires.
    expect(buyButton).toHaveProperty("disabled", false);

    // Submitting the form with an out-of-range value keeps the inline error
    // visible and never starts a checkout request.
    await actor.type(input, "{Enter}");
    expect(screen.getByRole("alert").id).toBe("purchase-amount-error");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/stripe/create-checkout-session",
      expect.anything(),
    );
  });

  it("marks the field invalid and shows the inline error when the initially empty form is submitted", async () => {
    routeApi();
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    const input = screen.getByLabelText("Amount (USD)");
    // Clean baseline: no error, not invalid, described only by the hint.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.getAttribute("aria-describedby")).toBe("purchase-amount-hint");

    // Submit the still-empty form through the enabled submit button. Before the
    // fix this only fired a toast and left the field aria-invalid=false with no
    // adjacent error.
    const buyButton = screen.getByRole("button", { name: /Buy credits/i });
    expect(buyButton).toHaveProperty("disabled", false);
    await actor.click(buyButton);

    const alert = await screen.findByRole("alert");
    expect(alert.id).toBe("purchase-amount-error");
    expect(alert.textContent).toMatch(/Minimum amount is \$1/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(
      "purchase-amount-hint purchase-amount-error",
    );
    // An empty submit must never start a checkout request.
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/stripe/create-checkout-session",
      expect.anything(),
    );
  });

  it("submits the checkout form when Enter is pressed in the amount field", async () => {
    let resolveCheckout: (value: { url?: string }) => void = () => {};
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/invoices/list")) {
        return Promise.resolve({ invoices });
      }
      if (url.startsWith("/api/crypto/status")) {
        return Promise.resolve({ enabled: false });
      }
      if (url.startsWith("/api/stripe/create-checkout-session")) {
        // Stay in flight so the processing label can be observed.
        return new Promise((resolve) => {
          resolveCheckout = resolve;
        });
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    const input = screen.getByLabelText("Amount (USD)");
    await actor.type(input, "25");
    // Enter inside the single amount field submits the surrounding form.
    await actor.type(input, "{Enter}");

    await waitFor(() => {
      const checkoutCall = apiMock.mock.calls.find((call) =>
        String(call[0]).startsWith("/api/stripe/create-checkout-session"),
      );
      expect(checkoutCall).toBeDefined();
      const init = checkoutCall?.[1] as {
        method?: string;
        json?: unknown;
        headers?: Record<string, string>;
      };
      expect(init.method).toBe("POST");
      expect(init.json).toEqual({ amount: 25, returnUrl: "settings" });
      // The idempotency key is present and satisfies the server contract
      // (#24144); Enter and click submissions share the same handler.
      expect(init.headers?.["Idempotency-Key"]).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/,
      );
    });
    // The in-flight label stays verb-first ("Processing…"), never a passive
    // "Redirected" state.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Processing/ })).toBeTruthy();
    });
    expect(screen.queryByText(/Redirected|Redirecting/)).toBeNull();

    // Resolve and let the resulting state update flush inside act.
    resolveCheckout({});
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy();
    });
  });
});

describe("BillingTab navigation guards", () => {
  it("refuses a non-http(s) Stripe checkout URL instead of navigating", async () => {
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/invoices/list")) {
        return Promise.resolve({ invoices });
      }
      if (url.startsWith("/api/crypto/status")) {
        return Promise.resolve({ enabled: false });
      }
      if (url.startsWith("/api/stripe/create-checkout-session")) {
        return Promise.resolve({ url: "javascript:alert(1)" });
      }
      return Promise.resolve({});
    });
    const { toast } = await import("sonner");
    const originalHref = window.location.href;
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    const input = screen.getByLabelText("Amount (USD)");
    await actor.type(input, "25");
    await actor.click(screen.getByRole("button", { name: /Buy credits/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Checkout URL is not a valid URL",
      );
    });
    // The top window never left: the wire URL was rejected before assignment.
    expect(window.location.href).toBe(originalHref);
    // The processing state resets so the user can retry.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy();
    });
  });

  it("refuses a non-http(s) crypto payment link instead of navigating", async () => {
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/invoices/list")) {
        return Promise.resolve({ invoices });
      }
      if (url.startsWith("/api/crypto/status")) {
        return Promise.resolve({ enabled: true });
      }
      if (url.startsWith("/api/crypto/payments")) {
        return Promise.resolve({ payLink: "javascript:alert(1)" });
      }
      return Promise.resolve({});
    });
    const { toast } = await import("sonner");
    const originalHref = window.location.href;
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await actor.click(screen.getByRole("button", { name: /Crypto/i }));
    const input = screen.getByLabelText("Amount (USD)");
    await actor.type(input, "25");
    await actor.click(screen.getByRole("button", { name: /Pay with Crypto/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Payment link is not a valid URL",
      );
    });
    expect(window.location.href).toBe(originalHref);
    expect(toast.success).not.toHaveBeenCalledWith(
      "Redirecting to payment page...",
    );
  });

  it("refreshes the canonical snapshot after direct crypto confirmation", async () => {
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/invoices/list")) {
        return Promise.resolve({ invoices });
      }
      if (url.startsWith("/api/crypto/status")) {
        return Promise.resolve({
          enabled: true,
          directWallet: { enabled: true, networks: [], promotion: {} },
        });
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await actor.type(screen.getByLabelText("Amount (USD)"), "25");
    await actor.click(screen.getByRole("button", { name: "Crypto" }));
    await actor.click(
      await screen.findByRole("button", { name: "Confirm direct crypto" }),
    );

    await waitFor(() => expect(snapshotRefetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        apiMock.mock.calls.filter(([url]) =>
          String(url).startsWith("/api/invoices/list"),
        ),
      ).toHaveLength(2);
    });
  });
});

describe("BillingTab hero + invoice presentation", () => {
  it("renders hero, amount, and invoice totals with tabular numbers", async () => {
    routeApi();
    render(<BillingTab user={user} />);

    const hero = await screen.findByText("$12.50");
    expect(hero.className).toMatch(/tabular-nums/);

    const input = screen.getByLabelText("Amount (USD)");
    expect(input.className).toMatch(/tabular-nums/);

    const rows = await screen.findAllByTestId("invoice-row");
    const firstTotal = within(rows[0]).getByText("$25.00");
    expect(firstTotal.className).toMatch(/tabular-nums/);
  });

  it("uses the exact snapshot balance and never calls the legacy balance endpoint", async () => {
    snapshotQuery.current = readySnapshotQuery(
      "900719925474099312345678.123456",
    );
    routeApi();
    render(<BillingTab user={user} />);

    expect(
      await screen.findByText("$900,719,925,474,099,312,345,678.123456"),
    ).toBeTruthy();
    await screen.findAllByTestId("invoice-row");
    expect(
      apiMock.mock.calls.some(([url]) =>
        String(url).startsWith("/api/credits/balance"),
      ),
    ).toBe(false);
  });

  it("marks a cached balance as refreshing, failed, or paused beside the value", async () => {
    const query = readySnapshotQuery();
    query.isFetching = true;
    snapshotQuery.current = query;
    routeApi();
    const { rerender } = render(<BillingTab user={user} />);

    expect(
      (
        await screen.findByText(
          "Refreshing balance. Showing the value observed at 2026-08-21 10:20:30 UTC.",
        )
      ).getAttribute("role"),
    ).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe(
      "Refreshing active compute.",
    );

    query.isFetching = false;
    query.isRefetchError = true;
    rerender(<BillingTab user={user} />);
    expect(
      screen
        .getByText(
          "Could not refresh balance. Showing the value observed at 2026-08-21 10:20:30 UTC.",
        )
        .getAttribute("role"),
    ).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not refresh. Showing the snapshot completed at",
    );

    query.isRefetchError = false;
    query.fetchStatus = "paused";
    rerender(<BillingTab user={user} />);
    expect(
      screen
        .getByText(
          "Balance refresh paused. Showing the value observed at 2026-08-21 10:20:30 UTC.",
        )
        .getAttribute("role"),
    ).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain(
      "Refresh paused. Showing the snapshot completed at",
    );
    expect(screen.getByText("$12.50")).toBeTruthy();
  });

  it("keeps purchases and invoices visible when the snapshot balance is unavailable", async () => {
    const query = readySnapshotQuery();
    query.data.balance = {
      status: "unavailable",
      source: "credit-ledger",
      observedAt: OBSERVED_AT,
      error: { code: "ledger_read_failed", retryable: true },
    } as unknown as typeof query.data.balance;
    snapshotQuery.current = query;
    routeApi();
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    expect(await screen.findByText("Balance unavailable")).toBeTruthy();
    await actor.click(screen.getByRole("button", { name: "Retry balance" }));
    expect(snapshotRefetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy();
    expect(await screen.findAllByTestId("invoice-row")).toHaveLength(2);
  });

  it("reflows the invoice list without a fixed min-width scroller", async () => {
    routeApi();
    const { container } = render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    expect(container.querySelector(".min-w-\\[600px\\]")).toBeNull();

    const rows = screen.getAllByTestId("invoice-row");
    // Each row stacks on narrow screens (flex-col) and only becomes a column
    // layout from `sm` up, so it reflows at 320px with no horizontal scroller.
    for (const row of rows) {
      expect(row.className).toMatch(/flex-col/);
      expect(row.className).toMatch(/sm:flex-row/);
    }
  });

  it("shows each invoice status as text plus a non-color-only icon", async () => {
    routeApi();
    render(<BillingTab user={user} />);

    const rows = await screen.findAllByTestId("invoice-row");

    const paid = within(rows[0]).getByText("paid");
    const paidStatus = paid.parentElement as HTMLElement;
    expect(paidStatus.querySelector("svg")).not.toBeNull();
    expect(paidStatus.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );

    const pending = within(rows[1]).getByText("pending");
    const pendingStatus = pending.parentElement as HTMLElement;
    expect(pendingStatus.querySelector("svg")).not.toBeNull();
  });
});
