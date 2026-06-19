/**
 * FinancesView — overlay view for the Finances / money app.
 *
 * Data-fetching view over the four read-only money endpoints served by the
 * personal-assistant routes (PA owns the persistence; this plugin only renders):
 *   GET {base}/api/lifeops/money/dashboard       (balance summary)
 *   GET {base}/api/lifeops/money/transactions    (recent transactions)
 *   GET {base}/api/lifeops/money/recurring       (recurring charges)
 *   GET {base}/api/lifeops/money/sources         (connected-vs-disconnected)
 *
 * It renders one of four distinct states (loading, error, empty, populated) and
 * instruments its refresh + connect controls through the agent surface so the
 * floating chat can drive them.
 *
 * The default fetchers build URLs from `client.getBaseUrl()`; tests inject the
 * fetcher seam so they stay offline. The wire amounts arrive as USD floats; we
 * convert to minor units at the fetch boundary so the whole view renders through
 * the single `formatMinor` boundary helper.
 *
 * This plugin MUST NOT import from @elizaos/plugin-personal-assistant. The wire
 * DTOs below are declared locally to match the JSON shape PA emits.
 */

import { client } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { RefreshCw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FinanceBalanceSummaryDTO,
  FinanceTransactionDTO,
  RecurringChargeDTO,
} from "../../types.ts";

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

/**
 * Currency-aware status the DTO carries. The wire transaction has no posted/
 * pending split; debits/credits all settle to "posted" once imported.
 */
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
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Styling — CSS vars, orange accent only.
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = "finances-view-styles";

const FINANCES_VIEW_CSS = `
.finances-view-btn {
  min-height: 44px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.finances-view-btn-primary {
  background: var(--primary, #ff8a24);
  color: var(--primary-foreground, #fff);
  border: 1px solid var(--primary, #ff8a24);
}
.finances-view-btn-primary:hover {
  background: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
  border-color: color-mix(in srgb, var(--primary, #ff8a24) 82%, black);
}
.finances-view-btn-neutral {
  background: var(--surface, rgba(0, 0, 0, 0.04));
  color: var(--foreground, #111);
  border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
}
.finances-view-btn-neutral:hover {
  background: color-mix(in srgb, var(--foreground, #111) 8%, transparent);
}
.finances-view-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
`;

function useFinancesViewStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_TAG_ID;
    style.textContent = FINANCES_VIEW_CSS;
    document.head.appendChild(style);
  }, []);
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  height: "100%",
  boxSizing: "border-box",
  overflowY: "auto",
  background: "var(--background, #fff)",
  color: "var(--foreground, #111)",
  fontFamily: "system-ui, sans-serif",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const h1Style: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };
const h2Style: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600 };

const cardStyle: CSSProperties = {
  padding: 16,
  borderRadius: 8,
  border: "1px solid var(--border, rgba(0,0,0,0.08))",
  background: "var(--surface, rgba(0,0,0,0.02))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const statRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 14,
};

const statLabelStyle: CSSProperties = { opacity: 0.65 };
const statValueStyle: CSSProperties = { fontWeight: 600 };

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "8px 0",
  borderBottom: "1px solid var(--border, rgba(0,0,0,0.06))",
  fontSize: 14,
};

const rowMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

// ---------------------------------------------------------------------------
// Agent-instrumented controls (hooks cannot run inside .map()).
// ---------------------------------------------------------------------------

function RefreshButton({
  onActivate,
  disabled,
}: {
  onActivate: () => void;
  disabled: boolean;
}): ReactNode {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "finances-refresh",
    role: "button",
    label: "Refresh finances",
    group: "finances-toolbar",
    description: "Reload balance, transactions, and recurring charges",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="finances-view-btn finances-view-btn-neutral"
      onClick={onActivate}
      disabled={disabled}
      aria-label="Refresh"
      {...agentProps}
    >
      <RefreshCw className="h-4 w-4" />
    </button>
  );
}

function ConnectButton({ onActivate }: { onActivate: () => void }): ReactNode {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "finances-connect",
    role: "button",
    label: "Connect a payment source",
    group: "finances-actions",
    description: "Connect a bank, PayPal, or CSV so Eliza can track your money",
    onActivate,
  });
  return (
    <button
      ref={ref}
      type="button"
      className="finances-view-btn finances-view-btn-primary"
      onClick={onActivate}
      aria-label="Connect a payment source"
      {...agentProps}
    >
      Connect a source
    </button>
  );
}

function FinancesHeader({
  refetch,
  busy,
}: {
  refetch: () => void;
  busy: boolean;
}): ReactNode {
  return (
    <header style={sectionStyle}>
      <div style={headerRowStyle}>
        <h1 style={h1Style}>Finances</h1>
        <RefreshButton onActivate={refetch} disabled={busy} />
      </div>
    </header>
  );
}

function StatRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div style={statRowStyle}>
      <span style={statLabelStyle}>{label}</span>
      <span style={statValueStyle}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Populated sub-sections.
// ---------------------------------------------------------------------------

function BalanceCard({
  balance,
}: {
  balance: FinanceBalanceSummaryDTO;
}): ReactNode {
  return (
    <div style={cardStyle} data-testid="finances-balance">
      <h2 style={h2Style}>Balance</h2>
      <StatRow
        label="Net balance"
        value={formatMinor(balance.netBalanceMinor, balance.currency)}
      />
      <StatRow
        label="This month — in"
        value={formatMinor(balance.monthlyIncomeMinor, balance.currency)}
      />
      <StatRow
        label="This month — out"
        value={formatMinor(balance.monthlyOutflowMinor, balance.currency)}
      />
      <StatRow label="As of" value={formatDate(balance.asOf)} />
    </div>
  );
}

function TransactionsCard({
  transactions,
}: {
  transactions: FinanceTransactionDTO[];
}): ReactNode {
  return (
    <div style={cardStyle} data-testid="finances-transactions">
      <h2 style={h2Style}>Recent transactions</h2>
      {transactions.length > 0 ? (
        <ul style={listStyle} aria-label="Recent transactions">
          {transactions.map((tx) => (
            <li key={tx.id} style={rowStyle}>
              <span style={rowMainStyle}>
                <span style={statValueStyle}>{tx.description}</span>
                <span style={dimStyle}>
                  {formatDate(tx.occurredAt)}
                  {tx.category ? ` · ${tx.category}` : ""}
                </span>
              </span>
              <span style={statValueStyle}>
                {formatMinor(tx.amountMinor, tx.currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div style={dimStyle}>No transactions in this window.</div>
      )}
    </div>
  );
}

function RecurringCard({
  recurring,
}: {
  recurring: RecurringChargeDTO[];
}): ReactNode {
  return (
    <div style={cardStyle} data-testid="finances-recurring">
      <h2 style={h2Style}>Recurring charges</h2>
      {recurring.length > 0 ? (
        <ul style={listStyle} aria-label="Recurring charges">
          {recurring.map((row) => (
            <li key={row.id} style={rowStyle}>
              <span style={rowMainStyle}>
                <span style={statValueStyle}>{row.label}</span>
                <span style={dimStyle}>
                  {row.cadence} · next {formatDate(row.nextChargeAt)}
                </span>
              </span>
              <span style={statValueStyle}>
                {formatMinor(row.amountMinor, row.currency)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div style={dimStyle}>No recurring charges detected.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

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

export function FinancesView(props: FinancesViewProps = {}): ReactNode {
  useFinancesViewStyles();

  const fetchers = props.fetchers ?? defaultFetchers;
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;

  const load = useCallback(() => {
    let cancelled = false;
    setState({ kind: "loading" });
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
        if (cancelled) return;
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

  const requestConnect = useCallback(() => {
    client.sendChatMessage?.(
      "Connect a payment source so you can track my money.",
    );
  }, []);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="finances-loading">
        <FinancesHeader refetch={load} busy={true} />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading finances…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="finances-error">
        <FinancesHeader refetch={load} busy={false} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load finances</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="finances-view-btn finances-view-btn-primary"
              onClick={load}
              aria-label="Retry loading finances"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  const { hasSource, balance, transactions, recurring } = state.data;

  // No payment source connected → honest connect-a-source affordance. This is
  // the disconnected state; show no fabricated balances.
  if (!hasSource) {
    return (
      <div style={containerStyle} data-testid="finances-empty">
        <FinancesHeader refetch={load} busy={false} />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>No money sources connected</div>
          <div style={dimStyle}>
            Connect a bank, PayPal, or import a CSV so Eliza can track your
            balance, transactions, and recurring charges. Nothing is shown until
            a source is linked.
          </div>
          <div>
            <ConnectButton onActivate={requestConnect} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-testid="finances-populated">
      <FinancesHeader refetch={load} busy={false} />
      <section style={sectionStyle}>
        <BalanceCard balance={balance} />
        <TransactionsCard transactions={transactions} />
        <RecurringCard recurring={recurring} />
      </section>
    </div>
  );
}

export default FinancesView;
