/**
 * FinancesView — the single GUI/XR data wrapper for the owner finance dashboard.
 *
 * It owns the live money data (the fetcher seams over the four read-only
 * endpoints PA serves, the quiet background poll, wire->display mapping, the
 * USD-float->minor-units boundary, and the proactive signal) and renders the one
 * presentational {@link FinancesSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` auto-detect the host
 * surface, so the SAME component serves them all. The view ships GUI-only.
 *
 * Data sources (PA owns the persistence; this plugin only reads):
 *   GET {base}/api/lifeops/money/dashboard       (balance summary)
 *   GET {base}/api/lifeops/money/sources         (connected-vs-disconnected)
 *   GET {base}/api/lifeops/money/transactions    (recent transactions)
 *   GET {base}/api/lifeops/money/recurring       (recurring charges)
 *
 * The client DISPLAYS, never COMPUTES: every total, sign, and currency amount is
 * resolved HERE into a pre-formatted string and handed to the spatial view as a
 * snapshot. The owner actions are `connect` (route a connect-a-source request
 * through the assistant chat — no fabricated balances) and `retry` (reload after
 * an error). This plugin MUST NOT import from @elizaos/plugin-personal-assistant;
 * the wire DTOs below are declared locally to match the JSON shape PA emits.
 */

import { client } from "@elizaos/ui";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FinanceBalanceSummaryDTO,
  FinanceTransactionDTO,
  RecurringChargeDTO,
} from "../../types.ts";
import {
  EMPTY_FINANCES_SNAPSHOT,
  type FinanceBalanceCard,
  type FinanceRecurringCard,
  type FinancesSnapshot,
  FinancesSpatialView,
  type FinanceTransactionCard,
} from "./FinancesSpatialView.tsx";

// ---------------------------------------------------------------------------
// Wire DTOs — local mirror of the JSON shape served by the PA money routes.
// Amounts are USD floats on the wire; never import PA types here.
// ---------------------------------------------------------------------------

interface MoneySpendingWire {
  windowDays: number;
  fromDate: string;
  toDate: string;
  totalSpendUsd: number;
  totalIncomeUsd: number;
  netUsd: number;
  transactionCount: number;
}

interface MoneyDashboardWire {
  spending: MoneySpendingWire;
  generatedAt: string;
}

type MoneySourceStatusWire = "active" | "disconnected" | "needs_attention";

interface MoneySourceWire {
  id: string;
  kind: string;
  label: string;
  institution: string | null;
  status: MoneySourceStatusWire;
}

interface MoneySourcesWire {
  sources: MoneySourceWire[];
}

type MoneyDirectionWire = "debit" | "credit";

interface MoneyTransactionWire {
  id: string;
  postedAt: string;
  amountUsd: number;
  direction: MoneyDirectionWire;
  merchantDisplay?: string | null;
  merchantNormalized: string;
  merchantRaw: string;
  description: string | null;
  category: string | null;
  currency: string;
}

interface MoneyTransactionsWire {
  transactions: MoneyTransactionWire[];
}

interface MoneyRecurringWire {
  merchantNormalized: string;
  merchantDisplay: string;
  cadence: string;
  averageAmountUsd: number;
  nextExpectedAt: string | null;
  category: string | null;
}

interface MoneyRecurringChargesWire {
  charges: MoneyRecurringWire[];
}

// ---------------------------------------------------------------------------
// Fetcher seams — default to real GETs; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface FinancesFetchers {
  fetchDashboard: () => Promise<MoneyDashboardWire>;
  fetchSources: () => Promise<MoneySourcesWire>;
  fetchTransactions: () => Promise<MoneyTransactionsWire>;
  fetchRecurring: () => Promise<MoneyRecurringChargesWire>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${client.getBaseUrl()}${path}`);
  if (!response.ok) {
    throw new Error(`Money request failed (${response.status}): ${path}`);
  }
  return (await response.json()) as T;
}

const defaultFetchers: FinancesFetchers = {
  fetchDashboard: () =>
    getJson<MoneyDashboardWire>("/api/lifeops/money/dashboard"),
  fetchSources: () => getJson<MoneySourcesWire>("/api/lifeops/money/sources"),
  fetchTransactions: () =>
    getJson<MoneyTransactionsWire>("/api/lifeops/money/transactions"),
  fetchRecurring: () =>
    getJson<MoneyRecurringChargesWire>("/api/lifeops/money/recurring"),
};

export interface FinancesViewProps {
  /** Owner display name (host injection seam). */
  ownerName?: string;
  /** Test/host injection seam. Defaults to real `/api/lifeops/money/*` GETs. */
  fetchers?: FinancesFetchers;
}

// ---------------------------------------------------------------------------
// Wire -> display DTO mapping (USD float -> minor units at the boundary).
// ---------------------------------------------------------------------------

const USD = "USD";

function usdToMinor(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

function mapBalance(dashboard: MoneyDashboardWire): FinanceBalanceSummaryDTO {
  const { spending } = dashboard;
  return {
    netBalanceMinor: usdToMinor(spending.netUsd),
    currency: USD,
    monthlyIncomeMinor: usdToMinor(spending.totalIncomeUsd),
    monthlyOutflowMinor: usdToMinor(spending.totalSpendUsd),
    asOf: dashboard.generatedAt,
  };
}

function mapTransaction(tx: MoneyTransactionWire): FinanceTransactionDTO {
  // A debit is money leaving the account: render as a negative (outflow). The
  // wire amount is unsigned, so the direction carries the sign.
  const signedUsd = tx.direction === "debit" ? -tx.amountUsd : tx.amountUsd;
  const description =
    tx.description ??
    tx.merchantDisplay ??
    tx.merchantNormalized ??
    "Transaction";
  return {
    id: tx.id,
    occurredAt: tx.postedAt,
    amountMinor: usdToMinor(signedUsd),
    currency: tx.currency || USD,
    description,
    category: tx.category,
    merchant: tx.merchantDisplay ?? tx.merchantNormalized ?? null,
    status: "posted",
    source: null,
  };
}

const RECURRING_CADENCES = new Set([
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
]);

function mapRecurring(charge: MoneyRecurringWire): RecurringChargeDTO {
  // The wire cadence has more variants (biweekly/annual/irregular) than the
  // display enum; normalize annual -> yearly and fall back to monthly for the
  // ones the display enum cannot represent. Display only — no math.
  const normalized =
    charge.cadence === "annual"
      ? "yearly"
      : RECURRING_CADENCES.has(charge.cadence)
        ? charge.cadence
        : "monthly";
  return {
    id: charge.merchantNormalized,
    label: charge.merchantDisplay || charge.merchantNormalized,
    amountMinor: usdToMinor(charge.averageAmountUsd),
    currency: USD,
    cadence: normalized as RecurringChargeDTO["cadence"],
    nextChargeAt: charge.nextExpectedAt,
    merchant: charge.merchantDisplay || charge.merchantNormalized,
    active: true,
  };
}

/**
 * Load-bearing render boundary: minor units (cents) -> grouped currency string.
 * Kept here (not in a util) because format-minor.test.ts pins it to this file.
 */
export function formatMinor(amountMinor: number, currency: string): string {
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/**
 * One quiet line of proactive agent context (design law 10): surface a single
 * genuine, actionable money signal — never a placeholder. Precedence:
 *   1. a negative net balance (overdrawn), then
 *   2. recurring bills landing within the next 7 days.
 * Returns "" when neither holds, so the line renders nothing on no signal.
 * Computed entirely from data the view already loads; no new imports.
 */
function proactiveNote(
  balance: FinanceBalanceSummaryDTO,
  recurring: RecurringChargeDTO[],
  now: number = Date.now(),
): string {
  if (balance.netBalanceMinor < 0) {
    return `Balance is negative (${formatMinor(
      balance.netBalanceMinor,
      balance.currency,
    )}).`;
  }
  const weekFromNow = now + 7 * 24 * 60 * 60 * 1000;
  const dueSoon = recurring.filter((row) => {
    if (!row.nextChargeAt) return false;
    const due = new Date(row.nextChargeAt).getTime();
    return !Number.isNaN(due) && due >= now && due <= weekFromNow;
  }).length;
  if (dueSoon > 0) {
    return `${dueSoon} bill${dueSoon === 1 ? "" : "s"} due this week.`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Display-DTO -> spatial-card projection (pre-format every string HERE).
// ---------------------------------------------------------------------------

function toBalanceCard(balance: FinanceBalanceSummaryDTO): FinanceBalanceCard {
  return {
    net: formatMinor(balance.netBalanceMinor, balance.currency),
    negative: balance.netBalanceMinor < 0,
    income: formatMinor(balance.monthlyIncomeMinor, balance.currency),
    outflow: formatMinor(balance.monthlyOutflowMinor, balance.currency),
    asOf: formatDate(balance.asOf),
  };
}

function toTransactionCard(tx: FinanceTransactionDTO): FinanceTransactionCard {
  const date = formatDate(tx.occurredAt);
  const meta = tx.category ? `${date} • ${tx.category}` : date;
  return {
    id: tx.id,
    description: tx.description,
    meta,
    amount: formatMinor(tx.amountMinor, tx.currency),
    outflow: tx.amountMinor < 0,
  };
}

function toRecurringCard(row: RecurringChargeDTO): FinanceRecurringCard {
  const next = formatDate(row.nextChargeAt);
  const meta = next ? `${row.cadence} • next ${next}` : row.cadence;
  return {
    id: row.id,
    label: row.label,
    meta,
    amount: formatMinor(row.amountMinor, row.currency),
  };
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000;

interface FinancesData {
  hasSource: boolean;
  balance: FinanceBalanceSummaryDTO;
  transactions: FinanceTransactionDTO[];
  recurring: RecurringChargeDTO[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: FinancesData };

function requestConnectSource(): void {
  // The connect-a-source affordance routes through the assistant chat. `client`
  // does not type `sendChatMessage`, so read it through a narrow optional-method
  // view and call it only when present — no fabricated balances.
  const send = (client as { sendChatMessage?: (text: string) => void })
    .sendChatMessage;
  send?.("Connect a payment source so you can track my money.");
}

export function FinancesView(props: FinancesViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  const load = useCallback((quiet = false) => {
    let cancelled = false;
    if (!quiet) setState({ kind: "loading" });
    Promise.all([
      fetchersRef.current.fetchDashboard(),
      fetchersRef.current.fetchSources(),
      fetchersRef.current.fetchTransactions(),
      fetchersRef.current.fetchRecurring(),
    ])
      .then(([dashboard, sources, transactions, recurring]) => {
        if (cancelled) return;
        const connected = sources.sources.some(
          (source) => source.status !== "disconnected",
        );
        setState({
          kind: "ready",
          data: {
            hasSource: connected,
            balance: mapBalance(dashboard),
            transactions: transactions.transactions.map(mapTransaction),
            recurring: recurring.charges.map(mapRecurring),
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || quiet) return;
        setState({
          kind: "error",
          message:
            error instanceof Error ? error.message : "Could not load finances.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  // Poll quietly every 30s so the dashboard stays fresh without a manual
  // refresh. Transient poll failures are ignored — the explicit Retry path is
  // what surfaces errors to the user.
  useEffect(() => {
    const id = setInterval(() => load(true), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  const snapshot = useMemo<FinancesSnapshot>(() => {
    if (state.kind === "loading") {
      return EMPTY_FINANCES_SNAPSHOT;
    }
    if (state.kind === "error") {
      return {
        ...EMPTY_FINANCES_SNAPSHOT,
        state: "error",
        error: state.message,
      };
    }
    const { hasSource, balance, transactions, recurring } = state.data;
    if (!hasSource) {
      return { ...EMPTY_FINANCES_SNAPSHOT, state: "empty" };
    }
    return {
      state: "ready",
      balance: toBalanceCard(balance),
      transactions: transactions.map(toTransactionCard),
      recurring: recurring.map(toRecurringCard),
      note: proactiveNote(balance, recurring),
    };
  }, [state]);

  const onAction = useCallback(
    (action: string) => {
      if (action === "retry") {
        load();
        return;
      }
      if (action === "connect") {
        requestConnectSource();
        return;
      }
      // `txn-<id>` / `bill-<id>` open affordances route to chat; PA owns the
      // detail surface, so this view never fabricates a drill-down.
      if (action.startsWith("txn-") || action.startsWith("bill-")) {
        const send = (client as { sendChatMessage?: (text: string) => void })
          .sendChatMessage;
        send?.(`Show me the details for ${action}.`);
      }
    },
    [load],
  );

  return <FinancesSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default FinancesView;
