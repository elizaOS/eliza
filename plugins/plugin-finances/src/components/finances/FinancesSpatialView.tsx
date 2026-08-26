/**
 * FinancesSpatialView — the owner finance dashboard authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI today through `<SpatialSurface>` (DOM).
 *   - Future adapters can reuse the same snapshot contract behind the retained modality types.
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * without pulling browser-only runtime imports into the presentational layer.
 *
 * The balance, transactions, and recurring charges — including every currency
 * amount — arrive ALREADY FORMATTED as display strings from the data wrapper
 * ({@link ./FinancesView.tsx}); this component never fetches, computes a total,
 * or runs financial math. It displays the snapshot and dispatches actions.
 */

import { Button, Card, HStack, List, Text, VStack } from "@elizaos/ui/spatial";

/**
 * Which render state the dashboard is in. `reauth` is distinct from `empty`:
 * sources exist but every one needs re-authentication, so the dashboard must
 * not render balances that can no longer refresh as if they were healthy.
 */
export type FinancesViewState =
  | "loading"
  | "error"
  | "empty"
  | "reauth"
  | "ready";

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

/** One connected payment source row, already projected to display strings. */
export interface FinanceSourceCard {
  id: string;
  label: string;
  /** Pre-formatted secondary line (institution + kind). */
  meta: string;
  /** Pre-formatted status label (e.g. "Connected", "Needs reconnect"). */
  statusLabel: string;
  /** True when the source needs re-authentication (renders the reconnect affordance). */
  needsReauth: boolean;
}

/** One filter chip, already labeled by the wrapper; `action` is the dispatch id. */
export interface FinanceFilterChip {
  action: string;
  label: string;
  active: boolean;
}

export interface FinancesSnapshot {
  /** The dashboard state machine. */
  state: FinancesViewState;
  /** Balance summary (only meaningful when state === "ready"). */
  balance: FinanceBalanceCard;
  /** Recent transactions (only meaningful when state === "ready"). */
  transactions: FinanceTransactionCard[];
  /**
   * Count of transactions in the unfiltered window; when it exceeds
   * `transactions.length`, an active filter is hiding rows and the empty
   * transaction list is a designed-empty filter result, not "no data".
   */
  transactionsTotal: number;
  /** Recurring charges (only meaningful when state === "ready"). */
  recurring: FinanceRecurringCard[];
  /** Connected payment sources (meaningful when state is "ready" or "reauth"). */
  sources: FinanceSourceCard[];
  /** Date-window / category filter chips (only meaningful when state === "ready"). */
  filters: FinanceFilterChip[];
  /** One quiet proactive line, or empty when there is no genuine signal. */
  note: string;
  /**
   * True when the last quiet refresh failed and the rendered data may be out
   * of date; drives a visible staleness line instead of silent fake freshness.
   */
  stale: boolean;
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
  transactionsTotal: 0,
  recurring: [],
  sources: [],
  filters: [],
  note: "",
  stale: false,
};

export interface FinancesSpatialViewProps {
  snapshot: FinancesSnapshot;
  /**
   * Dispatch by agent id:
   *   `retry`            reload after an error,
   *   `connect`          route a connect-a-source request to chat,
   *   `reconnect-<id>`   route a re-authentication request to chat,
   *   `filter-*`         toggle a date-window/category filter (wrapper-owned),
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
    <Card gap={3} padding={6} width="100%" shrink={0}>
      {snapshot.state === "loading" ? (
        <Text tone="muted" align="center" style="caption">
          Loading
        </Text>
      ) : snapshot.state === "error" ? (
        <FinancesErrorBody snapshot={snapshot} dispatch={dispatch} />
      ) : snapshot.state === "empty" ? (
        <FinancesEmptyBody dispatch={dispatch} />
      ) : snapshot.state === "reauth" ? (
        <FinancesReauthBody snapshot={snapshot} dispatch={dispatch} />
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
    <VStack
      gap={2}
      width="100%"
      agent={{
        id: "finances-empty",
        role: "status",
        label: "No payment sources connected",
      }}
    >
      <Text style="heading" bold>
        Finances
      </Text>
      <Text tone="muted">
        Connect a payment source to see balances, transactions, and recurring
        charges.
      </Text>
      <HStack gap={1}>
        <Button
          agent="connect"
          tone="muted"
          variant="outline"
          onPress={dispatch("connect")}
        >
          Connect a source
        </Button>
      </HStack>
    </VStack>
  );
}

function FinancesReauthBody({
  snapshot,
  dispatch,
}: {
  snapshot: FinancesSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <>
      <Text bold>Reconnect needed</Text>
      <Text tone="warning" style="caption">
        Every payment source needs re-authentication. Balances cannot refresh
        until a source is reconnected.
      </Text>
      <List gap={0}>
        {snapshot.sources.map((source) => (
          <HStack key={source.id} gap={1} align="center" width="100%">
            <VStack gap={0} grow={1}>
              <Text bold wrap={false}>
                {source.label}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                {source.meta}
              </Text>
            </VStack>
            <Button
              agent={`reconnect-${source.id}`}
              onPress={dispatch(`reconnect-${source.id}`)}
            >
              Reconnect
            </Button>
          </HStack>
        ))}
      </List>
      <HStack gap={1}>
        <Button agent="retry" onPress={dispatch("retry")}>
          Retry
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
      {snapshot.stale ? (
        <Text tone="warning" style="caption">
          Data may be out of date. The last refresh failed.
        </Text>
      ) : null}
      <BalanceSection balance={snapshot.balance} />
      <SourcesSection sources={snapshot.sources} dispatch={dispatch} />
      <FiltersSection filters={snapshot.filters} dispatch={dispatch} />
      <TransactionsSection
        transactions={snapshot.transactions}
        transactionsTotal={snapshot.transactionsTotal}
        dispatch={dispatch}
      />
      <RecurringSection recurring={snapshot.recurring} dispatch={dispatch} />
    </>
  );
}

function SourcesSection({
  sources,
  dispatch,
}: {
  sources: FinanceSourceCard[];
  dispatch: (action: string) => () => void;
}) {
  if (sources.length === 0) return null;
  return (
    <>
      <Text style="caption" tone="muted">
        Sources ({sources.length})
      </Text>
      <List gap={0}>
        {sources.map((source) => (
          <HStack key={source.id} gap={1} align="center" width="100%">
            <VStack gap={0} grow={1}>
              <Text bold wrap={false}>
                {source.label}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                {source.meta}
              </Text>
            </VStack>
            <Text
              style="caption"
              tone={source.needsReauth ? "warning" : "muted"}
              wrap={false}
            >
              {source.statusLabel}
            </Text>
            {source.needsReauth ? (
              <Button
                agent={`reconnect-${source.id}`}
                onPress={dispatch(`reconnect-${source.id}`)}
              >
                Reconnect
              </Button>
            ) : null}
          </HStack>
        ))}
      </List>
    </>
  );
}

function FiltersSection({
  filters,
  dispatch,
}: {
  filters: FinanceFilterChip[];
  dispatch: (action: string) => () => void;
}) {
  if (filters.length === 0) return null;
  return (
    <HStack gap={1} width="100%">
      {filters.map((chip) => (
        <Button
          key={chip.action}
          agent={chip.action}
          tone={chip.active ? "primary" : "muted"}
          variant={chip.active ? "solid" : "ghost"}
          pressed={chip.active}
          onPress={dispatch(chip.action)}
        >
          {chip.label}
        </Button>
      ))}
    </HStack>
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
  transactionsTotal,
  dispatch,
}: {
  transactions: FinanceTransactionCard[];
  transactionsTotal: number;
  dispatch: (action: string) => () => void;
}) {
  const filteredOut = transactionsTotal > transactions.length;
  return (
    <>
      <Text style="caption" tone="muted">
        Transactions (
        {filteredOut
          ? `${transactions.length} of ${transactionsTotal}`
          : transactions.length}
        )
      </Text>
      {transactions.length === 0 ? (
        <Text tone="muted" style="caption">
          {filteredOut ? "No transactions match the filter" : "None"}
        </Text>
      ) : (
        <List gap={0} padding={{ bottom: 1 }}>
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
                variant="ghost"
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
                variant="ghost"
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
