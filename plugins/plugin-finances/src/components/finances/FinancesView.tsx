/**
 * FinancesView — the GUI data wrapper for the owner finance dashboard.
 *
 * It owns the live money data (the fetcher seams over the four read-only
 * endpoints PA serves, the quiet background poll, wire->display mapping, the
 * USD-float->minor-units boundary, and the proactive signal) and renders the one
 * presentational {@link FinancesSpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` render the browser DOM
 * surface today while the retained modality contract stays available for future
 * adapters.
 *
 * Data sources (PA owns the persistence; this plugin only reads):
 *   GET {base}/api/lifeops/money/dashboard       (balance summary)
 *   GET {base}/api/lifeops/money/sources         (connected-vs-disconnected)
 *   GET {base}/api/lifeops/money/transactions    (recent transactions)
 *   GET {base}/api/lifeops/money/recurring       (recurring charges)
 *
 * The client DISPLAYS, never COMPUTES: every total, sign, and currency amount is
 * resolved HERE into a pre-formatted string and handed to the spatial view as a
 * snapshot. The owner actions are `connect` / `reconnect-<id>` (routed through
 * the assistant chat — no fabricated balances, no in-view credential flow),
 * `retry` (reload after an error), and the local `filter-*` chips (display
 * narrowing of already-loaded rows). When every non-disconnected source needs
 * re-authentication the view renders the distinct `reauth` state instead of
 * balances that can no longer refresh, and a failed quiet poll marks the data
 * stale instead of faking freshness.
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant;
 * the wire DTOs below are declared locally to match the JSON shape PA emits.
 */

import { client } from "@elizaos/ui/api";

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
  type FinanceFilterChip,
  type FinanceRecurringCard,
  type FinanceSourceCard,
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

/**
 * Client-side display filters over the loaded transaction list. `windowDays`
 * limits rows to the last N days; `category` matches the wire category exactly.
 * Both are DISPLAY narrowing of already-loaded rows — never a re-fetch and
 * never an input to any total.
 */
export interface FinanceViewFilters {
  windowDays: number | null;
  category: string | null;
}

const NO_FILTERS: FinanceViewFilters = { windowDays: null, category: null };

export interface FinancesViewProps {
  /** Owner display name (host injection seam). */
  ownerName?: string;
  /** Test/host injection seam. Defaults to real `/api/lifeops/money/*` GETs. */
  fetchers?: FinancesFetchers;
  /**
   * Filtered-view handoff seam: a host (e.g. a chat deep link) can open the
   * dashboard pre-narrowed to a date window and/or category.
   */
  initialFilters?: Partial<FinanceViewFilters>;
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

const SOURCE_STATUS_LABELS: Record<MoneySourceStatusWire, string> = {
  active: "Connected",
  needs_attention: "Needs reconnect",
  disconnected: "Disconnected",
};

function toSourceCard(source: MoneySourceWire): FinanceSourceCard {
  const meta = source.institution
    ? `${source.institution} • ${source.kind}`
    : source.kind;
  return {
    id: source.id,
    label: source.label,
    meta,
    statusLabel: SOURCE_STATUS_LABELS[source.status],
    needsReauth: source.status === "needs_attention",
  };
}

interface FinancesData {
  hasSource: boolean;
  /** True when every non-disconnected source needs re-authentication. */
  needsReauth: boolean;
  sources: MoneySourceWire[];
  balance: FinanceBalanceSummaryDTO;
  transactions: FinanceTransactionDTO[];
  recurring: RecurringChargeDTO[];
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: FinancesData; stale: boolean };

const FILTER_WINDOWS_DAYS = [7, 30, 90] as const;
/** Category chips stay a one-row scan; deeper slicing goes through chat. */
const MAX_CATEGORY_CHIPS = 5;

function applyFilters(
  transactions: FinanceTransactionDTO[],
  filters: FinanceViewFilters,
  now: number = Date.now(),
): FinanceTransactionDTO[] {
  const cutoff =
    filters.windowDays === null
      ? null
      : now - filters.windowDays * 24 * 60 * 60 * 1000;
  return transactions.filter((tx) => {
    if (filters.category !== null && tx.category !== filters.category) {
      return false;
    }
    if (cutoff !== null) {
      const at = new Date(tx.occurredAt).getTime();
      if (Number.isNaN(at) || at < cutoff) return false;
    }
    return true;
  });
}

function buildFilterChips(
  transactions: FinanceTransactionDTO[],
  filters: FinanceViewFilters,
): FinanceFilterChip[] {
  const chips: FinanceFilterChip[] = [
    {
      action: "filter-clear",
      label: "All",
      active: filters.windowDays === null && filters.category === null,
    },
  ];
  for (const days of FILTER_WINDOWS_DAYS) {
    chips.push({
      action: `filter-window-${days}`,
      label: `${days}d`,
      active: filters.windowDays === days,
    });
  }
  const categories = [
    ...new Set(
      transactions
        .map((tx) => tx.category)
        .filter((category): category is string => category !== null),
    ),
  ]
    .sort()
    .slice(0, MAX_CATEGORY_CHIPS);
  for (const category of categories) {
    chips.push({
      action: `filter-category-${category}`,
      label: category,
      active: filters.category === category,
    });
  }
  return chips;
}

function requestConnectSource(): void {
  // The connect-a-source affordance routes through the assistant chat. `client`
  // does not type `sendChatMessage`, so read it through a narrow optional-method
  // view and call it only when present — no fabricated balances.
  const chatClient = client as {
    sendChatMessage?: (text: string) => void;
  };
  chatClient.sendChatMessage?.(
    "Connect a payment source so you can track my money.",
  );
}

export function FinancesView(props: FinancesViewProps = {}): ReactNode {
  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [filters, setFilters] = useState<FinanceViewFilters>(() => ({
    ...NO_FILTERS,
    ...props.initialFilters,
  }));

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
        const connectedSources = sources.sources.filter(
          (source) => source.status !== "disconnected",
        );
        const needsReauth =
          connectedSources.length > 0 &&
          connectedSources.every(
            (source) => source.status === "needs_attention",
          );
        setState({
          kind: "ready",
          stale: false,
          data: {
            hasSource: connectedSources.length > 0,
            needsReauth,
            sources: sources.sources,
            balance: mapBalance(dashboard),
            transactions: transactions.transactions.map(mapTransaction),
            recurring: recurring.charges.map(mapRecurring),
          },
        });
      })
      .catch((error: unknown) => {
        // error-policy:J4 — a fetch failure becomes the visibly distinct error
        // state; a failed QUIET refresh keeps the last good data but marks it
        // stale so the dashboard never fakes freshness.
        if (cancelled) return;
        if (quiet) {
          setState((prev) =>
            prev.kind === "ready" ? { ...prev, stale: true } : prev,
          );
          return;
        }
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
    const {
      hasSource,
      needsReauth,
      sources,
      balance,
      transactions,
      recurring,
    } = state.data;
    if (!hasSource) {
      return { ...EMPTY_FINANCES_SNAPSHOT, state: "empty" };
    }
    const sourceCards = sources.map(toSourceCard);
    if (needsReauth) {
      // Provider auth is broken everywhere: render the reauth state, never the
      // stale balances as healthy success.
      return {
        ...EMPTY_FINANCES_SNAPSHOT,
        state: "reauth",
        sources: sourceCards,
      };
    }
    const visible = applyFilters(transactions, filters);
    return {
      state: "ready",
      balance: toBalanceCard(balance),
      transactions: visible.map(toTransactionCard),
      transactionsTotal: transactions.length,
      recurring: recurring.map(toRecurringCard),
      sources: sourceCards,
      filters: buildFilterChips(transactions, filters),
      note: proactiveNote(balance, recurring),
      stale: state.stale,
    };
  }, [state, filters]);

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
      // Filter chips narrow the already-loaded rows locally; no re-fetch.
      if (action === "filter-clear") {
        setFilters(NO_FILTERS);
        return;
      }
      if (action.startsWith("filter-window-")) {
        const days = Number(action.slice("filter-window-".length));
        setFilters((prev) => ({
          ...prev,
          windowDays: prev.windowDays === days ? null : days,
        }));
        return;
      }
      if (action.startsWith("filter-category-")) {
        const category = action.slice("filter-category-".length);
        setFilters((prev) => ({
          ...prev,
          category: prev.category === category ? null : category,
        }));
        return;
      }
      // Re-authentication routes through the assistant chat; this view never
      // hosts a credential flow itself.
      if (action.startsWith("reconnect-")) {
        const sourceId = action.slice("reconnect-".length);
        const label =
          state.kind === "ready"
            ? (state.data.sources.find((source) => source.id === sourceId)
                ?.label ?? sourceId)
            : sourceId;
        const chatClient = client as {
          sendChatMessage?: (text: string) => void;
        };
        chatClient.sendChatMessage?.(
          `Reconnect my "${label}" payment source — it needs re-authentication.`,
        );
        return;
      }
      // `txn-<id>` / `bill-<id>` open affordances route to chat; PA owns the
      // detail surface, so this view never fabricates a drill-down.
      if (action.startsWith("txn-") || action.startsWith("bill-")) {
        const chatClient = client as {
          sendChatMessage?: (text: string) => void;
        };
        chatClient.sendChatMessage?.(`Show me the details for ${action}.`);
      }
    },
    [load, state],
  );

  return <FinancesSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default FinancesView;
