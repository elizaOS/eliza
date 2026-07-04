/**
 * @vitest-environment jsdom
 *
 * Drives the unified FinancesView (the single GUI/XR data wrapper) through the
 * rendered DOM: the same component the bundle exports for both the "gui" and
 * "xr" modalities. It reads the four read-only money endpoints PA serves:
 *   GET {base}/api/lifeops/money/dashboard | sources | transactions | recurring
 *
 * The default fetchers build URLs via `client.getBaseUrl()`; every test injects
 * the `fetchers` seam so the suite stays offline. We assert the rendered spatial
 * DOM across the four states (loading / error / empty / populated), the
 * USD-float -> minor-units -> formatted-string boundary, the proactive line, the
 * connect affordance routed through `client.sendChatMessage`, and the quiet
 * background poll.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// FinancesView only touches base URL and chat affordances from the UI client.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
  client: {
    getBaseUrl: () => "http://test.local",
    sendChatMessage,
  },
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

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  sendChatMessage.mockClear();
});

describe("FinancesView — states", () => {
  it("shows the loading state while the first fetch is in flight", () => {
    const never = new Promise<never>(() => {});
    render(
      <FinancesView fetchers={makeFetchers({ fetchDashboard: () => never })} />,
    );
    expect(screen.getByText("Loading")).toBeTruthy();
  });

  it("renders the populated dashboard with balance, transactions and recurring charges", async () => {
    render(<FinancesView fetchers={makeFetchers()} />);
    await screen.findByText("Latte");
    // Pre-formatted strings (computed in the wrapper, not the spatial view).
    expect(screen.getByText("$2,765.50")).toBeTruthy();
    expect(screen.getByText("-$42.50")).toBeTruthy();
    expect(screen.getByText("Netflix")).toBeTruthy();
    expect(screen.getByText("$15.99")).toBeTruthy();
    // Clickable rows are instrumented for the agent surface.
    expect(agent("txn-tx-1")).toBeTruthy();
    expect(agent("bill-netflix")).toBeTruthy();
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
    await screen.findByText("Netflix");
    expect(screen.getByText("1 bill due this week.")).toBeTruthy();
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
    await screen.findByText("Netflix");
    expect(screen.getByText(/Balance is negative/)).toBeTruthy();
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
    await screen.findByText("Netflix");
    expect(screen.queryByText(/due this week/)).toBeNull();
    expect(screen.queryByText(/Balance is negative/)).toBeNull();
  });

  it("shows the connect-a-source empty state when no source is connected (no fabricated balances)", async () => {
    render(
      <FinancesView
        fetchers={makeFetchers({
          fetchSources: async () => sources("disconnected"),
        })}
      />,
    );
    await screen.findByText("None");
    expect(agent("connect")).toBeTruthy();
    // No fabricated balance surfaces in the disconnected state.
    expect(screen.queryByText("$2,765.50")).toBeNull();
  });

  it("routes the connect affordance through the assistant chat", async () => {
    render(
      <FinancesView
        fetchers={makeFetchers({
          fetchSources: async () => sources("disconnected"),
        })}
      />,
    );
    await screen.findByText("None");
    fireEvent.click(agent("connect"));
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
    await screen.findByText("boom");
    fireEvent.click(agent("retry"));
    await screen.findByText("Latte");
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
      // Flush the initial mount fetch.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);

      // The quiet poll fires on its interval (30s) and refetches.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
