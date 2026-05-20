'use client';

import { cn, formatCompactCurrency } from '@feed/shared';
import { Activity, Plus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { z } from 'zod';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

/**
 * Trade type schema for validation.
 */
const TradeTypeSchema = z.enum(['balance', 'npc', 'position']);
type TradeType = z.infer<typeof TradeTypeSchema>;

/**
 * User schema for validation.
 */
const UserSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  profileImageUrl: z.string().nullable(),
  isActor: z.boolean(),
});

/**
 * Base trade schema for validation.
 */
const BaseTradeSchema = z.object({
  type: TradeTypeSchema,
  id: z.string(),
  timestamp: z.coerce.date(),
  user: UserSchema.nullable(),
});

/**
 * Balance trade schema for validation.
 */
const BalanceTradeSchema = BaseTradeSchema.extend({
  type: z.literal('balance'),
  amount: z.string(),
  balanceBefore: z.string(),
  balanceAfter: z.string(),
  transactionType: z.string(),
  description: z.string().nullable(),
  relatedId: z.string().nullable(),
});
type BalanceTrade = z.infer<typeof BalanceTradeSchema>;

/**
 * NPC trade schema for validation.
 */
const NPCTradeSchema = BaseTradeSchema.extend({
  type: z.literal('npc'),
  marketType: z.string(),
  ticker: z.string().nullable(),
  marketId: z.string().nullable(),
  action: z.string(),
  side: z.string().nullable(),
  amount: z.number(),
  price: z.number(),
  sentiment: z.number().nullable(),
  reason: z.string().nullable(),
});
type NPCTrade = z.infer<typeof NPCTradeSchema>;

/**
 * Position trade schema for validation.
 */
const PositionTradeSchema = BaseTradeSchema.extend({
  type: z.literal('position'),
  market: z.object({
    id: z.string(),
    question: z.string(),
    resolved: z.boolean(),
    resolution: z.boolean().nullable(),
  }),
  side: z.string(),
  shares: z.string(),
  avgPrice: z.string(),
  createdAt: z.coerce.date(),
});
type PositionTrade = z.infer<typeof PositionTradeSchema>;

/**
 * Trade schema union for validation.
 */
const TradeSchema = z.discriminatedUnion('type', [
  BalanceTradeSchema,
  NPCTradeSchema,
  PositionTradeSchema,
]);
type Trade = z.infer<typeof TradeSchema>;

/**
 * Trading feed tab component for viewing and creating trades.
 *
 * Displays a feed of all trades in the system with filtering by trade type.
 * Shows trade details and includes a form for creating test trades. Auto-refreshes
 * every 10 seconds. Used for admin testing and monitoring.
 *
 * Features:
 * - Trade feed display
 * - Trade type filtering
 * - Trade creation form
 * - Auto-refresh (10s interval)
 * - Loading states
 * - Error handling
 *
 * @returns Trading feed tab element
 */
export function TradingFeedTab() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | TradeType>('all');
  const [isRefreshing, startRefresh] = useTransition();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Show/hide form fields based on trade type
  useEffect(() => {
    const tradeTypeSelect = document.querySelector<HTMLSelectElement>(
      'select[name="tradeType"]'
    );
    const balanceFields = document.getElementById('balanceFields');
    const npcFields = document.getElementById('npcFields');

    const handleTradeTypeChange = () => {
      if (!tradeTypeSelect || !balanceFields || !npcFields) return;

      if (tradeTypeSelect.value === 'balance') {
        balanceFields.classList.remove('hidden');
        npcFields.classList.add('hidden');
        // Make balance fields required
        balanceFields
          .querySelectorAll('input[required], select[required]')
          .forEach((el) => {
            el.setAttribute('required', '');
          });
        // Remove required from NPC fields
        npcFields.querySelectorAll('input[required]').forEach((el) => {
          el.removeAttribute('required');
        });
      } else {
        balanceFields.classList.add('hidden');
        npcFields.classList.remove('hidden');
        // Remove required from balance fields
        balanceFields
          .querySelectorAll('input[required], select[required]')
          .forEach((el) => {
            el.removeAttribute('required');
          });
        // Make NPC fields required
        npcFields.querySelectorAll('input[required]').forEach((el) => {
          el.setAttribute('required', '');
        });
      }
    };

    tradeTypeSelect?.addEventListener('change', handleTradeTypeChange);
    // Set initial state
    handleTradeTypeChange();

    return () => {
      tradeTypeSelect?.removeEventListener('change', handleTradeTypeChange);
    };
  }, []);

  const fetchAndSetTrades = useCallback(async () => {
    const url =
      filter === 'all'
        ? '/api/admin/trades?limit=50'
        : `/api/admin/trades?limit=50&type=${filter}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error('Failed to fetch trades');
    const data = await response.json();
    const validation = z.array(TradeSchema).safeParse(data.trades);
    if (!validation.success) {
      throw new Error('Invalid trade data structure');
    }
    setTrades(validation.data || []);
    setLoading(false);
  }, [filter]);

  const fetchTrades = useCallback(
    (showRefreshing = false) => {
      if (showRefreshing) {
        startRefresh(async () => {
          await fetchAndSetTrades();
        });
      } else {
        fetchAndSetTrades();
      }
    },
    [fetchAndSetTrades]
  );

  useEffect(() => {
    fetchTrades();
    const interval = setInterval(() => fetchTrades(), 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [fetchTrades]);

  const handleCreateTrade = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);

    const formData = new FormData(e.currentTarget);
    const tradeType = formData.get('tradeType') as string;
    const payload: Record<string, unknown> = { type: tradeType };

    if (tradeType === 'balance') {
      payload.userId = formData.get('userId') as string;
      payload.transactionType = formData.get('transactionType') as string;
      payload.amount = parseFloat(formData.get('amount') as string);
      payload.description =
        (formData.get('description') as string) || undefined;
      payload.relatedId = (formData.get('relatedId') as string) || undefined;
      payload.updateBalance = formData.get('updateBalance') === 'true';
    } else if (tradeType === 'npc') {
      payload.npcActorId = formData.get('npcActorId') as string;
      payload.marketType = formData.get('marketType') as string;
      payload.ticker = (formData.get('ticker') as string) || undefined;
      payload.marketId = (formData.get('marketId') as string) || undefined;
      payload.action = formData.get('action') as string;
      payload.side = (formData.get('side') as string) || undefined;
      payload.amount = parseFloat(formData.get('amount') as string);
      payload.price = parseFloat(formData.get('price') as string);
      payload.sentiment = formData.get('sentiment')
        ? parseFloat(formData.get('sentiment') as string)
        : undefined;
      payload.reason = (formData.get('reason') as string) || undefined;
    }

    const response = await fetch(apiUrl('/api/admin/trades'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      setCreating(false);
      setCreateError(errorData.error || 'Failed to create trade');
      return;
    }

    // Refresh trades and close form
    await fetchAndSetTrades();
    setShowCreateForm(false);
    e.currentTarget.reset();
    setCreating(false);
  };

  /** Use shared formatCompactCurrency for currency formatting */
  const formatCurrency = (value: string | number) => {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    return formatCompactCurrency(Number.isNaN(num) ? 0 : num);
  };

  const formatTime = (timestamp: Date | string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  };

  const TradeCard = ({ trade }: { trade: Trade }) => {
    // Handle null user (should not happen, but be safe)
    if (!trade.user) return null;

    const displayName =
      trade.user.displayName || trade.user.username || 'Anonymous';

    return (
      <div className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-primary/50">
        <div className="flex items-start gap-3">
          <Avatar
            src={trade.user.profileImageUrl || undefined}
            alt={displayName}
            size="sm"
          />

          <div className="min-w-0 flex-1">
            {/* User Info */}
            <div className="mb-1 flex items-center gap-2">
              <span className="truncate font-medium">{displayName}</span>
              {trade.user.isActor && (
                <span className="rounded bg-purple-500/20 px-2 py-0.5 text-purple-500 text-xs">
                  NPC
                </span>
              )}
              <span className="text-muted-foreground text-xs">
                {formatTime(trade.timestamp)}
              </span>
            </div>

            {/* Trade Details */}
            {trade.type === 'balance' && <BalanceTradeDetails trade={trade} />}
            {trade.type === 'npc' && <NPCTradeDetails trade={trade} />}
            {trade.type === 'position' && (
              <PositionTradeDetails trade={trade} />
            )}
          </div>
        </div>
      </div>
    );
  };

  const BalanceTradeDetails = ({ trade }: { trade: BalanceTrade }) => {
    const amount = parseFloat(trade.amount);
    const isPositive = amount >= 0;

    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded px-2 py-1 font-medium text-xs',
              isPositive
                ? 'bg-green-500/20 text-green-500'
                : 'bg-red-500/20 text-red-500'
            )}
          >
            {trade.transactionType}
          </span>
          <span
            className={cn(
              'font-bold text-lg',
              isPositive ? 'text-green-600' : 'text-red-600'
            )}
          >
            {isPositive ? '+' : ''}
            {formatCurrency(amount)}
          </span>
        </div>
        {trade.description && (
          <p className="text-muted-foreground text-sm">{trade.description}</p>
        )}
        <div className="text-muted-foreground text-xs">
          Balance: {formatCurrency(trade.balanceBefore)} →{' '}
          {formatCurrency(trade.balanceAfter)}
        </div>
      </div>
    );
  };

  const NPCTradeDetails = ({ trade }: { trade: NPCTrade }) => {
    const isLong = trade.side === 'long' || trade.side === 'YES';

    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded px-2 py-1 font-medium text-xs',
              isLong
                ? 'bg-green-500/20 text-green-500'
                : 'bg-red-500/20 text-red-500'
            )}
          >
            {trade.action.toUpperCase()}
          </span>
          {trade.ticker && <span className="font-bold">{trade.ticker}</span>}
          {trade.side && (
            <span
              className={cn(
                'font-medium text-xs',
                isLong ? 'text-green-600' : 'text-red-600'
              )}
            >
              {trade.side}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span>Amount: {formatCurrency(trade.amount)}</span>
          <span>Price: {formatCurrency(trade.price)}</span>
          {trade.sentiment !== null && (
            <span
              className={cn(
                'text-xs',
                trade.sentiment > 0
                  ? 'text-green-600'
                  : trade.sentiment < 0
                    ? 'text-red-600'
                    : 'text-gray-600'
              )}
            >
              Sentiment: {trade.sentiment > 0 ? '+' : ''}
              {(trade.sentiment * 100).toFixed(0)}%
            </span>
          )}
        </div>
        {trade.reason && (
          <p className="text-muted-foreground text-xs italic">
            &quot;{trade.reason}&quot;
          </p>
        )}
      </div>
    );
  };

  const PositionTradeDetails = ({ trade }: { trade: PositionTrade }) => {
    const isYes = trade.side === 'YES';

    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded px-2 py-1 font-medium text-xs',
              isYes
                ? 'bg-green-500/20 text-green-500'
                : 'bg-red-500/20 text-red-500'
            )}
          >
            {trade.side}
          </span>
        </div>
        <p className="line-clamp-2 font-medium text-sm">
          {trade.market.question}
        </p>
        <div className="flex items-center gap-3 text-muted-foreground text-xs">
          <span>Shares: {parseFloat(trade.shares).toFixed(2)}</span>
          <span>Avg Price: {formatCurrency(trade.avgPrice)}</span>
        </div>
        {trade.market.resolved && (
          <div className="text-xs">
            <span className="text-muted-foreground">Resolved: </span>
            <span
              className={cn(
                'font-medium',
                trade.market.resolution ? 'text-green-600' : 'text-red-600'
              )}
            >
              {trade.market.resolution ? 'YES' : 'NO'}
            </span>
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="w-full space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          {(['all', 'balance', 'npc', 'position'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-3 py-1.5 font-medium text-sm transition-colors',
                filter === f
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              {f === 'all'
                ? 'All'
                : f === 'balance'
                  ? 'Balance'
                  : f === 'npc'
                    ? 'NPC'
                    : 'Position'}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="flex items-center gap-2 rounded bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            Create Trade
          </button>
          <button
            onClick={() => fetchTrades(true)}
            disabled={isRefreshing}
            className="flex items-center gap-2 rounded bg-muted px-3 py-1.5 font-medium text-sm transition-colors hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Create Trade Form */}
      {showCreateForm && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold text-lg">Create Trade</h3>
            <button
              onClick={() => {
                setShowCreateForm(false);
                setCreateError(null);
              }}
              className="rounded p-1 hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <form onSubmit={handleCreateTrade} className="space-y-4">
            <div>
              <label className="mb-1 block font-medium text-sm">
                Trade Type
              </label>
              <select
                name="tradeType"
                required
                className="w-full rounded-lg border border-border bg-muted px-3 py-2"
              >
                <option value="balance">Balance Transaction</option>
                <option value="npc">NPC Trade</option>
              </select>
            </div>

            {/* Balance Transaction Fields */}
            <div id="balanceFields" className="space-y-3">
              <div>
                <label className="mb-1 block font-medium text-sm">
                  User ID
                </label>
                <input
                  type="text"
                  name="userId"
                  required
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="User ID"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Transaction Type
                </label>
                <select
                  name="transactionType"
                  required
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                >
                  <option value="pred_buy">Prediction Buy</option>
                  <option value="pred_sell">Prediction Sell</option>
                  <option value="perp_open">Perp Open</option>
                  <option value="perp_close">Perp Close</option>
                  <option value="perp_liquidation">Perp Liquidation</option>
                  <option value="deposit">Deposit</option>
                  <option value="withdrawal">Withdrawal</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">Amount</label>
                <input
                  type="number"
                  name="amount"
                  required
                  step="0.01"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Description (optional)
                </label>
                <input
                  type="text"
                  name="description"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="Trade description"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Related ID (optional)
                </label>
                <input
                  type="text"
                  name="relatedId"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="Related entity ID"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="updateBalance"
                  value="true"
                  defaultChecked
                  className="h-4 w-4"
                />
                <label className="text-sm">Update user balance</label>
              </div>
            </div>

            {/* NPC Trade Fields */}
            <div id="npcFields" className="hidden space-y-3">
              <div>
                <label className="mb-1 block font-medium text-sm">
                  NPC Actor ID
                </label>
                <input
                  type="text"
                  name="npcActorId"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="Actor ID"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Market Type
                </label>
                <select
                  name="marketType"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                >
                  <option value="prediction">Prediction</option>
                  <option value="perp">Perpetual</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Ticker (for perp)
                </label>
                <input
                  type="text"
                  name="ticker"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="Ticker symbol"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Market ID (for prediction)
                </label>
                <input
                  type="text"
                  name="marketId"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="Market ID"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">Action</label>
                <input
                  type="text"
                  name="action"
                  required
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="e.g., BUY, SELL"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Side (optional)
                </label>
                <input
                  type="text"
                  name="side"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="e.g., long, short, YES, NO"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">Amount</label>
                <input
                  type="number"
                  name="amount"
                  required
                  step="0.01"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">Price</label>
                <input
                  type="number"
                  name="price"
                  required
                  step="0.01"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Sentiment (optional)
                </label>
                <input
                  type="number"
                  name="sentiment"
                  step="0.01"
                  min="-1"
                  max="1"
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="-1 to 1"
                />
              </div>
              <div>
                <label className="mb-1 block font-medium text-sm">
                  Reason (optional)
                </label>
                <textarea
                  name="reason"
                  rows={3}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2"
                  placeholder="Trade reasoning"
                />
              </div>
            </div>

            {createError && (
              <div className="rounded bg-red-500/10 p-2 text-red-500 text-sm">
                {createError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? 'Creating...' : 'Create Trade'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCreateForm(false);
                  setCreateError(null);
                }}
                className="rounded-lg bg-muted px-4 py-2 text-foreground hover:bg-muted/80"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Trades List */}
      {trades.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Activity className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>No trades found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {trades.map((trade) => (
            <TradeCard key={trade.id} trade={trade} />
          ))}
        </div>
      )}
    </div>
  );
}
