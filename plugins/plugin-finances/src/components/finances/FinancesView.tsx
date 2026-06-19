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
 * It renders one of four distinct states (loading, error, empty, populated),
 * polls every 30s to stay fresh, and instruments its connect control through
 * the agent surface so the floating chat can drive it.
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

/**
 * One quiet line of proactive agent context (design law 10): surface a single
 * genuine, actionable money signal — never a placeholder. Precedence:
 *   1. a negative net balance (overdrawn), then
 *   2. recurring bills landing within the next 7 days.
 * Returns null when neither holds, so the line renders nothing on no signal.
 * Computed entirely from data the view already loads; no new imports.
 */
function proactiveNote(
  balance: FinanceBalanceSummaryDTO,
  recurring: RecurringChargeDTO[],
  now: number = Date.now(),
): string | null {
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
  return null;
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

const populatedSectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 32,
};

const h1Style: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 600 };
const h2Style: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600 };

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const dimStyle: CSSProperties = {
  opacity: 0.65,
  fontSize: 13,
  lineHeight: 1.5,
};

const statValueStyle: CSSProperties = { fontWeight: 600 };

const balanceHeadlineStyle: CSSProperties = {
  fontSize: 32,
  fontWeight: 600,
  lineHeight: 1.1,
};

const balanceSublineStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  fontSize: 13,
  opacity: 0.65,
};

const captionStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.5,
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "8px 0",
  borderBottom: "1px solid var(--border, rgba(0,0,0,0.04))",
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

function FinancesHeader(): ReactNode {
  return (
    <header style={sectionStyle}>
      <h1 style={h1Style}>Finances</h1>
    </header>
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
      <div style={balanceHeadlineStyle}>
        {formatMinor(balance.netBalanceMinor, balance.currency)}
      </div>
      <div style={balanceSublineStyle}>
        <span>
          In {formatMinor(balance.monthlyIncomeMinor, balance.currency)}
        </span>
        <span>
          Out {formatMinor(balance.monthlyOutflowMinor, balance.currency)}
        </span>
      </div>
      <div style={captionStyle}>As of {formatDate(balance.asOf)}</div>
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

  // Poll quietly every 30s so the dashboard stays fresh without a manual refresh.
  useEffect(() => {
    const id = setInterval(() => load(true), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const refresh = useCallback(() => load(), [load]);

  const requestConnect = useCallback(() => {
    client.sendChatMessage?.(
      "Connect a payment source so you can track my money.",
    );
  }, []);

  if (state.kind === "loading") {
    return (
      <div style={containerStyle} data-testid="finances-loading">
        <FinancesHeader />
        <div style={{ ...cardStyle, ...dimStyle }}>Loading finances…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={containerStyle} data-testid="finances-error">
        <FinancesHeader />
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>Couldn’t load finances</div>
          <div style={dimStyle}>{state.message}</div>
          <div>
            <button
              type="button"
              className="finances-view-btn finances-view-btn-primary"
              onClick={refresh}
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
        <FinancesHeader />
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

  const note = proactiveNote(balance, recurring);

  return (
    <div style={containerStyle} data-testid="finances-populated">
      <FinancesHeader />
      {note ? (
        <div style={dimStyle} data-testid="finances-proactive-note">
          {note}
        </div>
      ) : null}
      <section style={populatedSectionStyle}>
        <BalanceCard balance={balance} />
        <TransactionsCard transactions={transactions} />
        <RecurringCard recurring={recurring} />
      </section>
    </div>
  );
}

export default FinancesView;
