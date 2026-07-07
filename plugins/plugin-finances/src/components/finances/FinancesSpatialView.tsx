/**
 * FinancesSpatialView — the owner finance dashboard authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — the spatial primitives still render to terminal lines via
 *                `@elizaos/ui/spatial/tui`, but the plugin no longer ships a
 *                terminal registration (GUI-only view inventory).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no browser/client import).
 *
 * The balance, transactions, and recurring charges — including every currency
 * amount — arrive ALREADY FORMATTED as display strings from the data wrapper
 * ({@link ./FinancesView.tsx}); this component never fetches, computes a total,
 * or runs financial math. It displays the snapshot and dispatches actions.
 */

import { Button, Card, HStack, List, Text, VStack } from "@elizaos/ui/spatial";

/** Which render state the dashboard is in. */
export type FinancesViewState = "loading" | "error" | "empty" | "ready";

/** A balance summary row, already projected to display strings by the wrapper. */
export interface FinanceBalanceCard {
  /** Pre-formatted net balance (e.g. "$2,765.50"). */
  net: string;
  /** True when the net balance is below zero (drives tone, no math here). */
  negative: boolean;
  /** Pre-formatted money in over the window (e.g. "$4,000.00"). */
  income: string;
  /** Pre-formatted money out over the window (e.g. "$1,234.50"). */
  outflow: string;
  /** Pre-formatted "as of" date label, or empty. */
  asOf: string;
}

/** One transaction row, already projected to display strings by the wrapper. */
export interface FinanceTransactionCard {
  id: string;
  description: string;
  /** Pre-formatted secondary line (date + optional category). */
  meta: string;
  /** Pre-formatted signed amount (e.g. "-$42.50"). */
  amount: string;
  /** True when the amount is an outflow (drives tone, no math here). */
  outflow: boolean;
}

/** One recurring-charge row, already projected to display strings. */
export interface FinanceRecurringCard {
  id: string;
  label: string;
  /** Pre-formatted secondary line (cadence + next-charge date). */
  meta: string;
  /** Pre-formatted amount (e.g. "$15.99"). */
  amount: string;
}

export interface FinancesSnapshot {
  /** The dashboard state machine. */
  state: FinancesViewState;
  /** Balance summary (only meaningful when state === "ready"). */
  balance: FinanceBalanceCard;
  /** Recent transactions (only meaningful when state === "ready"). */
  transactions: FinanceTransactionCard[];
  /** Recurring charges (only meaningful when state === "ready"). */
  recurring: FinanceRecurringCard[];
  /** One quiet proactive line, or empty when there is no genuine signal. */
  note: string;
  /** Error message when state === "error". */
  error?: string;
}

const EMPTY_BALANCE: FinanceBalanceCard = {
  net: "",
  negative: false,
  income: "",
  outflow: "",
  asOf: "",
};

export const EMPTY_FINANCES_SNAPSHOT: FinancesSnapshot = {
  state: "loading",
  balance: EMPTY_BALANCE,
  transactions: [],
  recurring: [],
  note: "",
};

export interface FinancesSpatialViewProps {
  snapshot: FinancesSnapshot;
  /**
   * Dispatch by agent id:
   *   `retry`            reload after an error,
   *   `connect`          route a connect-a-source request to chat,
   *   `txn-<id>`         open a transaction,
   *   `bill-<id>`        open a recurring charge.
   */
  onAction?: (action: string) => void;
}

export function FinancesSpatialView({
  snapshot,
  onAction,
}: FinancesSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);

  return (
    <Card gap={1} padding={1}>
      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading
        </Text>
      ) : snapshot.state === "error" ? (
        <FinancesErrorBody snapshot={snapshot} dispatch={dispatch} />
      ) : snapshot.state === "empty" ? (
        <FinancesEmptyBody dispatch={dispatch} />
      ) : (
        <FinancesReadyBody snapshot={snapshot} dispatch={dispatch} />
      )}
    </Card>
  );
}

function FinancesErrorBody({
  snapshot,
  dispatch,
}: {
  snapshot: FinancesSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>Could not load finances</Text>
      <Text tone="danger" style="caption">
        {snapshot.error ?? "Could not load finances."}
      </Text>
      <HStack gap={1}>
        <Button agent="retry" onPress={dispatch("retry")}>
          Retry
        </Button>
      </HStack>
    </>
  );
}

function FinancesEmptyBody({
  dispatch,
}: {
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>None</Text>
      <HStack gap={1}>
        <Button agent="connect" onPress={dispatch("connect")}>
          Connect
        </Button>
      </HStack>
    </>
  );
}

function FinancesReadyBody({
  snapshot,
  dispatch,
}: {
  snapshot: FinancesSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      {snapshot.note ? (
        <Text tone="warning" style="caption">
          {snapshot.note}
        </Text>
      ) : null}
      <BalanceSection balance={snapshot.balance} />
      <TransactionsSection
        transactions={snapshot.transactions}
        dispatch={dispatch}
      />
      <RecurringSection recurring={snapshot.recurring} dispatch={dispatch} />
    </>
  );
}

function BalanceSection({ balance }: { balance: FinanceBalanceCard }) {
  return (
    <>
      <Text style="caption" tone="muted">
        Balance
      </Text>
      <Text bold tone={balance.negative ? "danger" : "primary"} wrap={false}>
        {balance.net}
      </Text>
      <HStack gap={1} width="100%">
        <Text style="caption" tone="muted" wrap={false}>
          In {balance.income}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          Out {balance.outflow}
        </Text>
      </HStack>
      {balance.asOf ? (
        <Text style="caption" tone="muted" wrap={false}>
          As of {balance.asOf}
        </Text>
      ) : null}
    </>
  );
}

function TransactionsSection({
  transactions,
  dispatch,
}: {
  transactions: FinanceTransactionCard[];
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text style="caption" tone="muted">
        Transactions ({transactions.length})
      </Text>
      {transactions.length === 0 ? (
        <Text tone="muted" style="caption">
          None
        </Text>
      ) : (
        <List gap={0}>
          {transactions.map((tx) => (
            <HStack
              key={tx.id}
              gap={1}
              align="center"
              width="100%"
              agent={`txn-${tx.id}`}
            >
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {tx.description}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {tx.meta}
                </Text>
              </VStack>
              <Text tone={tx.outflow ? "danger" : "primary"} wrap={false}>
                {tx.amount}
              </Text>
              <Button
                agent={`open-txn-${tx.id}`}
                onPress={dispatch(`txn-${tx.id}`)}
              >
                ›
              </Button>
            </HStack>
          ))}
        </List>
      )}
    </>
  );
}

function RecurringSection({
  recurring,
  dispatch,
}: {
  recurring: FinanceRecurringCard[];
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text style="caption" tone="muted">
        Recurring ({recurring.length})
      </Text>
      {recurring.length === 0 ? (
        <Text tone="muted" style="caption">
          None
        </Text>
      ) : (
        <List gap={0}>
          {recurring.map((row) => (
            <HStack
              key={row.id}
              gap={1}
              align="center"
              width="100%"
              agent={`bill-${row.id}`}
            >
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {row.label}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {row.meta}
                </Text>
              </VStack>
              <Text wrap={false}>{row.amount}</Text>
              <Button
                agent={`open-bill-${row.id}`}
                onPress={dispatch(`bill-${row.id}`)}
              >
                ›
              </Button>
            </HStack>
          ))}
        </List>
      )}
    </>
  );
}
