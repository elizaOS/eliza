'use client';

import { cn, formatCurrency } from '@feed/shared';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BuyPointsModal } from '@/components/points/BuyPointsModal';
import { Skeleton } from '@/components/shared/Skeleton';
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/useWalletBalance';
import { getExplorerName, getExplorerTxUrl } from '@/lib/chain';
import { useAuthStore } from '@/stores/authStore';

/** Number of transactions to show in collapsed view */
const COLLAPSED_COUNT = 5;
/** Max height for scrollable transaction containers when expanded (in px) */
const EXPANDED_MAX_HEIGHT = 400;

interface FundingMetadata {
  amountUSD: string | number | null;
  paymentProvider: string | null;
  paymentTxHash: string | null;
}

/**
 * Transaction from the trading balance funding API.
 */
interface FundingTransaction {
  id: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  type: string;
  description: string | null;
  createdAt: string;
  relatedId: string | null;
  metadata: FundingMetadata;
}

/**
 * Parse funding metadata from the transaction description when it stores JSON.
 */
function parseFundingMetadata(description: string | null): FundingMetadata {
  if (!description) {
    return {
      amountUSD: null,
      paymentProvider: null,
      paymentTxHash: null,
    };
  }

  try {
    const parsed = JSON.parse(description) as Record<string, unknown>;
    return {
      amountUSD:
        typeof parsed.amountUSD === 'number' ||
        typeof parsed.amountUSD === 'string'
          ? parsed.amountUSD
          : null,
      paymentProvider:
        typeof parsed.paymentProvider === 'string'
          ? parsed.paymentProvider
          : null,
      paymentTxHash:
        typeof parsed.paymentTxHash === 'string' ? parsed.paymentTxHash : null,
    };
  } catch {
    return {
      amountUSD: null,
      paymentProvider: null,
      paymentTxHash: null,
    };
  }
}

/**
 * Get human-readable funding label.
 */
function getFundingLabel(tx: FundingTransaction): string {
  if (tx.description && !tx.description.startsWith('{')) {
    return tx.description;
  }

  const labels: Record<string, string> = {
    deposit: 'Balance Deposit',
    stripe_purchase: 'Card Funding',
    crypto_purchase: 'Crypto Funding',
    stripe_refund: 'Refund',
    stripe_dispute: 'Dispute Deduction',
    stripe_dispute_won: 'Dispute Reversal',
  };

  return (
    labels[tx.type] ||
    tx.type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * Format payment provider display.
 */
function getPaymentProviderLabel(provider: string | null): string {
  if (!provider) return '';
  if (provider === 'stripe') return 'Card';
  if (provider === 'crypto') return 'Crypto';
  return provider;
}

/**
 * Funding transaction row component.
 */
function FundingTransactionRow({ tx }: { tx: FundingTransaction }) {
  const isPurchase =
    tx.type === 'stripe_purchase' || tx.type === 'crypto_purchase';
  const isPositive = tx.amount > 0;
  // Pre-compute explorer URL to avoid duplicate function calls
  const explorerUrl =
    tx.metadata.paymentTxHash && tx.metadata.paymentProvider === 'crypto'
      ? getExplorerTxUrl(tx.metadata.paymentTxHash)
      : null;

  return (
    <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/30 p-4 transition-all hover:bg-muted/50">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{getFundingLabel(tx)}</span>
          {tx.metadata.paymentProvider && (
            <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs">
              {getPaymentProviderLabel(tx.metadata.paymentProvider)}
            </span>
          )}
        </div>
        <div className="mt-1 text-muted-foreground text-sm">
          {new Date(tx.createdAt).toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </div>
        {isPurchase && tx.metadata.amountUSD !== null && (
          <div className="mt-1 text-muted-foreground text-xs">
            Paid: ${Number(tx.metadata.amountUSD).toFixed(2)} USD
          </div>
        )}
        {explorerUrl && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-[#0066FF] text-xs hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            View on {getExplorerName()}
          </a>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div
          className={cn(
            'font-semibold text-lg',
            isPositive ? 'text-green-500' : 'text-red-500'
          )}
        >
          {isPositive ? '+' : ''}
          {tx.amount.toLocaleString()}
        </div>
        <div className="text-muted-foreground text-xs">
          Trading Balance: {tx.balanceAfter.toLocaleString()}
        </div>
      </div>
    </div>
  );
}

/**
 * Expandable transaction section with smooth transitions
 */
function TransactionSection({
  title,
  transactions,
  emptyMessage,
  emptyAction,
  renderRow,
  description,
}: {
  title: string;
  transactions: FundingTransaction[];
  emptyMessage: string;
  emptyAction?: { label: string; onClick: () => void };
  renderRow: (tx: FundingTransaction) => React.ReactNode;
  description?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = transactions.length > COLLAPSED_COUNT;
  const visibleTransactions = expanded
    ? transactions
    : transactions.slice(0, COLLAPSED_COUNT);

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-4 flex items-center gap-2">
        <h3 className="font-semibold">{title}</h3>
        {transactions.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
            {transactions.length}
          </span>
        )}
      </div>

      {description && (
        <p className="mb-4 text-muted-foreground text-sm">{description}</p>
      )}

      {transactions.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">{emptyMessage}</p>
          {emptyAction && (
            <button
              onClick={emptyAction.onClick}
              className="mt-3 text-[#0066FF] text-sm hover:underline"
            >
              {emptyAction.label}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Transaction list container */}
          <div
            className={cn(
              'space-y-3 transition-all duration-300 ease-in-out',
              expanded && hasMore && 'overflow-y-auto pr-1'
            )}
            style={{
              maxHeight: expanded && hasMore ? EXPANDED_MAX_HEIGHT : 'none',
            }}
          >
            {visibleTransactions.map((tx) => (
              <div key={tx.id}>{renderRow(tx)}</div>
            ))}
          </div>

          {/* Expand/collapse button */}
          {hasMore && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-4 flex w-full items-center justify-center rounded-lg border border-border py-2.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
            >
              {expanded
                ? 'Show less'
                : `Show all ${transactions.length} transactions`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Billing tab component for viewing funding and reputation transaction history.
 *
 * Shows:
 * - Current trading balance
 * - Transaction history with details (expandable sections)
 * - Balance funding button
 * - Payment method indicators (crypto vs card)
 */
export function BillingTab() {
  const { getAccessToken } = useAuth();
  const { user } = useAuthStore();
  const [transactions, setTransactions] = useState<FundingTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buyFundsOpen, setBuyFundsOpen] = useState(false);

  // Use the same hook as markets page to fetch fresh balance from API
  const {
    balance,
    loading: balanceLoading,
    refresh: refreshBalance,
  } = useWalletBalance(user?.id);

  const fetchTransactions = useCallback(async () => {
    if (!user?.id) return;

    setLoading(true);
    setError(null);

    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/users/trading-balance/funding?userId=${encodeURIComponent(user.id)}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        setError(data.error || 'Failed to load transaction history');
        return;
      }

      const data = await response.json();
      setTransactions(
        (data.transactions || []).map(
          (transaction: {
            id: string;
            amount: string;
            balanceBefore: string;
            balanceAfter: string;
            type: string;
            description: string | null;
            createdAt: string;
            relatedId: string | null;
          }) => ({
            id: transaction.id,
            amount: Number(transaction.amount),
            balanceBefore: Number(transaction.balanceBefore),
            balanceAfter: Number(transaction.balanceAfter),
            type: transaction.type,
            description: transaction.description,
            createdAt: transaction.createdAt,
            relatedId: transaction.relatedId,
            metadata: parseFundingMetadata(transaction.description),
          })
        )
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load transaction history'
      );
    } finally {
      setLoading(false);
    }
  }, [user?.id, getAccessToken]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const handleBuyPointsSuccess = async () => {
    await Promise.all([refreshBalance(), fetchTransactions()]);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="font-bold text-2xl">Billing & Transactions</h2>
        <p className="text-muted-foreground text-sm">
          View your trading balance and funding history.
        </p>
      </div>

      {/* Current Balance Card */}
      <div className="rounded-lg border border-border bg-gradient-to-br from-[#0066FF]/10 to-transparent p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-muted-foreground text-sm">Trading Balance</p>
            <div className="mt-1 flex items-baseline gap-2">
              {balanceLoading ? (
                <Skeleton className="h-10 w-32" />
              ) : (
                <span className="font-bold text-4xl text-foreground">
                  {formatCurrency(balance)}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => setBuyFundsOpen(true)}
            className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-yellow-500 to-amber-600 px-4 py-2.5 font-medium text-primary-foreground shadow-md transition-all hover:from-yellow-600 hover:to-amber-700 hover:shadow-lg"
          >
            Add Funds
          </button>
        </div>
      </div>

      {/* Loading State */}
      {loading ? (
        <div className="space-y-6">
          <div className="rounded-lg border border-border p-4">
            <div className="mb-4 flex items-center gap-2">
              <Skeleton className="h-5 w-5" />
              <Skeleton className="h-5 w-32" />
            </div>
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="rounded-lg border border-border p-4">
          <div className="py-8 text-center">
            <p className="text-red-500 text-sm">{error}</p>
            <button
              onClick={fetchTransactions}
              className="mt-2 text-[#0066FF] text-sm hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Purchase History Section */}
          <div className="relative">
            <button
              onClick={fetchTransactions}
              disabled={loading}
              className="absolute top-4 right-4 z-10 rounded p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Refresh"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </button>
            <TransactionSection
              title="Funding History"
              transactions={transactions}
              emptyMessage="No funding events yet"
              emptyAction={{
                label: 'Add your first funds',
                onClick: () => setBuyFundsOpen(true),
              }}
              description="Spendable balance funding events, refunds, disputes, and dispute reversals."
              renderRow={(tx) => <FundingTransactionRow tx={tx} />}
            />
          </div>
        </>
      )}

      {/* Pricing Info */}
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <h3 className="font-semibold">Funding</h3>
        <p className="mt-1 text-muted-foreground text-sm">
          <strong className="text-foreground">
            Funds add directly to your Trading Balance
          </strong>
          <br />
          Funding is available with credit card or cryptocurrency.
        </p>
      </div>

      {/* Buy Points Modal */}
      <BuyPointsModal
        isOpen={buyFundsOpen}
        onClose={() => setBuyFundsOpen(false)}
        onSuccess={handleBuyPointsSuccess}
      />
    </div>
  );
}
