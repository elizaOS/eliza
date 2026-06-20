// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `@elizaos/ui` is the giant renderer barrel; FinancesView only touches
// `client.getBaseUrl()` (default fetcher seam, overridden in every test) and
// `client.sendChatMessage()` (connect affordance). `@elizaos/ui/agent-surface`
// is mocked to an inert hook so the instrumented buttons render outside a
// provider.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { type FinancesFetchers, FinancesView } from "./FinancesView.js";

// ---------------------------------------------------------------------------
// Wire fixtures — one shape per fetch endpoint.
// ---------------------------------------------------------------------------

function dashboard() {
  return {
    spending: {
      windowDays: 30,
      fromDate: "2026-05-18",
      toDate: "2026-06-17",
      totalSpendUsd: 1234.5,
      totalIncomeUsd: 4000,
      netUsd: 2765.5,
      transactionCount: 12,
    },
    generatedAt: "2026-06-17T12:00:00.000Z",
  };
}

function sources(status: "active" | "disconnected" = "active") {
  return {
    sources: [
      {
        id: "src-1",
        kind: "plaid",
        label: "Checking",
        institution: "Acme Bank",
        status,
      },
    ],
  };
}

function transactions() {
  return {
    transactions: [
      {
        id: "tx-1",
        postedAt: "2026-06-16T09:00:00.000Z",
        amountUsd: 42.5,
        direction: "debit" as const,
        merchantDisplay: "Coffee Bar",
        merchantNormalized: "coffee-bar",
        merchantRaw: "COFFEE BAR #12",
        description: "Latte",
        category: "dining",
        currency: "USD",
      },
    ],
  };
}

function recurring() {
  return {
    charges: [
      {
        merchantNormalized: "netflix",
        merchantDisplay: "Netflix",
        cadence: "monthly",
        averageAmountUsd: 15.99,
        nextExpectedAt: "2026-07-01T00:00:00.000Z",
        category: "entertainment",
      },
    ],
  };
}

function makeFetchers(
  overrides: Partial<FinancesFetchers> = {},
): FinancesFetchers {
  return {
    fetchDashboard: async () => dashboard(),
    fetchSources: async () => sources("active"),
    fetchTransactions: async () => transactions(),
    fetchRecurring: async () => recurring(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("FinancesView", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(
      <FinancesView fetchers={makeFetchers({ fetchDashboard: () => never })} />,
    );
    expect(screen.getByTestId("finances-loading")).toBeTruthy();
  });

  it("renders the populated dashboard with balance, transactions and recurring charges", async () => {
    render(<FinancesView fetchers={makeFetchers()} />);
    expect(await screen.findByTestId("finances-populated")).toBeTruthy();
    expect(screen.getByTestId("finances-balance")).toBeTruthy();
    expect(screen.getByTestId("finances-transactions")).toBeTruthy();
    expect(screen.getByTestId("finances-recurring")).toBeTruthy();
    expect(screen.getByText(/Coffee Bar|Latte/)).toBeTruthy();
    expect(screen.getByText(/Netflix/)).toBeTruthy();
  });

  it("tops the populated view with a quiet proactive note for a bill due this week", async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    render(
      <FinancesView
        fetchers={makeFetchers({
          fetchRecurring: async () => ({
            charges: [
              {
                merchantNormalized: "netflix",
                merchantDisplay: "Netflix",
                cadence: "monthly",
                averageAmountUsd: 15.99,
                nextExpectedAt: soon,
                category: "entertainment",
              },
            ],
          }),
        })}
      />,
    );
    expect(await screen.findByTestId("finances-populated")).toBeTruthy();
    expect(screen.getByTestId("finances-proactive-note").textContent).toMatch(
      /1 bill due this week/,
    );
  });

  it("flags a negative balance over a due-soon bill (urgency precedence)", async () => {
    const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    render(
      <FinancesView
        fetchers={makeFetchers({
          fetchDashboard: async () => ({
            spending: {
              windowDays: 30,
              fromDate: "2026-05-18",
              toDate: "2026-06-17",
              totalSpendUsd: 4000,
              totalIncomeUsd: 1000,
              netUsd: -3000,
              transactionCount: 12,
            },
            generatedAt: "2026-06-17T12:00:00.000Z",
          }),
          fetchRecurring: async () => ({
            charges: [
              {
                merchantNormalized: "netflix",
                merchantDisplay: "Netflix",
                cadence: "monthly",
                averageAmountUsd: 15.99,
                nextExpectedAt: soon,
                category: "entertainment",
              },
            ],
          }),
        })}
      />,
    );
    expect(await screen.findByTestId("finances-populated")).toBeTruthy();
    expect(screen.getByTestId("finances-proactive-note").textContent).toMatch(
      /Balance is negative/,
    );
  });

  it("renders no proactive note when nothing is due soon and the balance is healthy", async () => {
    const far = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    render(
      <FinancesView
        fetchers={makeFetchers({
          fetchRecurring: async () => ({
            charges: [
              {
                merchantNormalized: "netflix",
                merchantDisplay: "Netflix",
                cadence: "monthly",
                averageAmountUsd: 15.99,
                nextExpectedAt: far,
                category: "entertainment",
              },
            ],
          }),
        })}
      />,
    );
    expect(await screen.findByTestId("finances-populated")).toBeTruthy();
    expect(screen.queryByTestId("finances-proactive-note")).toBeNull();
  });

  it("shows the connect-a-source empty state when no source is connected (no fabricated balances)", async () => {
    render(
      <FinancesView
        fetchers={makeFetchers({
          fetchSources: async () => sources("disconnected"),
        })}
      />,
    );
    expect(await screen.findByTestId("finances-empty")).toBeTruthy();
    expect(screen.getByText(/No money sources connected/i)).toBeTruthy();
    expect(screen.queryByTestId("finances-balance")).toBeNull();
  });

  it("routes the connect affordance through the assistant chat", async () => {
    render(
      <FinancesView
        fetchers={makeFetchers({
          fetchSources: async () => sources("disconnected"),
        })}
      />,
    );
    await screen.findByTestId("finances-empty");
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it("shows the error state with a Retry that refetches into the populated state", async () => {
    let attempt = 0;
    const fetchDashboard = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("boom");
      return dashboard();
    };
    render(<FinancesView fetchers={makeFetchers({ fetchDashboard })} />);
    expect(await screen.findByTestId("finances-error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByTestId("finances-populated")).toBeTruthy();
  });

  it("polls quietly to refetch and stay fresh without a manual control", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchDashboard = async () => {
        calls += 1;
        return dashboard();
      };
      render(<FinancesView fetchers={makeFetchers({ fetchDashboard })} />);
      await vi.waitFor(() =>
        expect(screen.getByTestId("finances-populated")).toBeTruthy(),
      );
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(calls).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
