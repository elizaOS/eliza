/**
 * FinancesView — minimal placeholder dashboard for @elizaos/plugin-finances.
 *
 * Three sections (per scaffold brief):
 *   1. Balance summary
 *   2. Transactions
 *   3. Recurring charges
 *
 * Data shapes match the DTOs in `../../types.ts`. The component renders the
 * passed-in props directly; once the OWNER_FINANCES action is migrated from
 * plugin-lifeops, those props will be sourced from a finances service /
 * provider rather than the parent overlay app.
 */

import { CreditCard, Repeat, Wallet } from "lucide-react";
import type { ReactElement } from "react";
import type {
  FinanceBalanceSummaryDTO,
  FinancesViewProps,
  FinanceTransactionDTO,
  RecurringChargeDTO,
} from "../../types.ts";

function formatMinor(amountMinor: number, currency: string): string {
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

function BalanceSummarySection({
  balance,
}: {
  balance?: FinanceBalanceSummaryDTO;
}): ReactElement {
  return (
    <section className="finances-section finances-balance">
      <header className="finances-section-header">
        <Wallet size={16} aria-hidden="true" />
        <h2>Balance</h2>
      </header>
      {balance ? (
        <dl className="finances-balance-grid">
          <div>
            <dt>Net balance</dt>
            <dd>{formatMinor(balance.netBalanceMinor, balance.currency)}</dd>
          </div>
          <div>
            <dt>This month — in</dt>
            <dd>{formatMinor(balance.monthlyIncomeMinor, balance.currency)}</dd>
          </div>
          <div>
            <dt>This month — out</dt>
            <dd>
              {formatMinor(balance.monthlyOutflowMinor, balance.currency)}
            </dd>
          </div>
          <div>
            <dt>As of</dt>
            <dd>{balance.asOf}</dd>
          </div>
        </dl>
      ) : (
        <p className="finances-empty">No balance data yet.</p>
      )}
    </section>
  );
}

function TransactionsSection({
  transactions,
}: {
  transactions?: FinanceTransactionDTO[];
}): ReactElement {
  return (
    <section className="finances-section finances-transactions">
      <header className="finances-section-header">
        <CreditCard size={16} aria-hidden="true" />
        <h2>Transactions</h2>
      </header>
      {transactions && transactions.length > 0 ? (
        <ul className="finances-transactions-list">
          {transactions.map((tx) => (
            <li key={tx.id} className="finances-transactions-row">
              <span className="finances-tx-date">{tx.occurredAt}</span>
              <span className="finances-tx-description">{tx.description}</span>
              <span className="finances-tx-amount">
                {formatMinor(tx.amountMinor, tx.currency)}
              </span>
              <span className="finances-tx-status">{tx.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="finances-empty">No transactions yet.</p>
      )}
    </section>
  );
}

function RecurringSection({
  recurring,
}: {
  recurring?: RecurringChargeDTO[];
}): ReactElement {
  return (
    <section className="finances-section finances-recurring">
      <header className="finances-section-header">
        <Repeat size={16} aria-hidden="true" />
        <h2>Recurring charges</h2>
      </header>
      {recurring && recurring.length > 0 ? (
        <ul className="finances-recurring-list">
          {recurring.map((row) => (
            <li key={row.id} className="finances-recurring-row">
              <span className="finances-recurring-label">{row.label}</span>
              <span className="finances-recurring-cadence">{row.cadence}</span>
              <span className="finances-recurring-amount">
                {formatMinor(row.amountMinor, row.currency)}
              </span>
              <span className="finances-recurring-next">
                {row.nextChargeAt ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="finances-empty">No recurring charges tracked.</p>
      )}
    </section>
  );
}

export function FinancesView(props: FinancesViewProps): ReactElement {
  return (
    <div className="finances-view">
      <BalanceSummarySection balance={props.balance} />
      <TransactionsSection transactions={props.transactions} />
      <RecurringSection recurring={props.recurring} />
    </div>
  );
}

export default FinancesView;
