'use client';

import { cn, logger } from '@feed/shared';
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle,
  Clock,
  DollarSign,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { getAuthToken } from '@/lib/auth';
import { formatCurrencyDefault } from '@/lib/format';
import { apiUrl } from '@/utils/api-url';

/**
 * Escrow schema for validation.
 */
const EscrowSchema = z.object({
  id: z.string(),
  recipientId: z.string(),
  recipient: z.object({
    id: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    profileImageUrl: z.string().nullable(),
  }),
  adminId: z.string(),
  admin: z.object({
    id: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
  }),
  amountUSD: z.string(),
  amountWei: z.string(),
  status: z.enum(['pending', 'paid', 'refunded', 'expired']),
  reason: z.string().nullable(),
  paymentRequestId: z.string().nullable(),
  paymentTxHash: z.string().nullable(),
  refundTxHash: z.string().nullable(),
  refundedBy: z.string().nullable(),
  refundedByUser: z
    .object({
      id: z.string(),
      username: z.string().nullable(),
      displayName: z.string().nullable(),
    })
    .nullable(),
  refundedAt: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
type Escrow = z.infer<typeof EscrowSchema>;

/**
 * Status filter type for escrow management tab.
 */
type StatusFilter = 'all' | 'pending' | 'paid' | 'refunded' | 'expired';

/**
 * Escrow management tab component for managing moderation escrow payments.
 *
 * Displays a list of escrow payments for moderation actions with filtering
 * by status. Shows payment details, recipient information, and provides
 * refund functionality. Includes transaction hash tracking and expiration
 * handling.
 *
 * Features:
 * - Escrow list display
 * - Status filtering
 * - Payment details
 * - Refund functionality
 * - Transaction hash tracking
 * - Expiration display
 * - Loading states
 * - Error handling
 *
 * @returns Escrow management tab element
 */
export function EscrowManagementTab() {
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, startRefresh] = useTransition();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedEscrow, setSelectedEscrow] = useState<Escrow | null>(null);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundTxHash, setRefundTxHash] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [isRefunding, setIsRefunding] = useState(false);

  const fetchEscrows = useCallback(
    (showRefreshing = false) => {
      const fetchLogic = async () => {
        const token = getAuthToken();
        const params = new URLSearchParams({
          limit: '100',
        });
        if (statusFilter !== 'all') {
          params.set('status', statusFilter);
        }

        const headers: HeadersInit = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(
          `/api/admin/moderation-escrow/list?${params}`,
          {
            headers,
          }
        );
        if (!response.ok) {
          toast.error('Failed to fetch escrows');
          setLoading(false);
          return;
        }
        const data = await response.json();
        const validated = z.array(EscrowSchema).parse(data.escrows);
        setEscrows(validated);
        setLoading(false);
      };

      if (showRefreshing) {
        startRefresh(fetchLogic);
      } else {
        void fetchLogic();
      }
    },
    [statusFilter]
  );

  useEffect(() => {
    fetchEscrows();
  }, [fetchEscrows]);

  const handleRefund = async () => {
    if (!selectedEscrow || !refundTxHash.trim()) {
      toast.error('Refund transaction hash is required');
      return;
    }

    setIsRefunding(true);
    const token = getAuthToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(
      apiUrl('/api/admin/moderation-escrow/refund'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          escrowId: selectedEscrow.id,
          refundTxHash: refundTxHash.trim(),
          reason: refundReason.trim() || undefined,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      setIsRefunding(false);
      logger.error(
        'Failed to refund escrow',
        { error: data.error },
        'EscrowManagementTab'
      );
      toast.error(data.error || 'Failed to refund escrow');
      return;
    }

    setShowRefundModal(false);
    setSelectedEscrow(null);
    setRefundTxHash('');
    setRefundReason('');
    fetchEscrows(true);
    setIsRefunding(false);
  };

  const formatCurrency = formatCurrencyDefault;

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid':
        return 'bg-green-500/20 text-green-500';
      case 'refunded':
        return 'bg-blue-500/20 text-blue-500';
      case 'expired':
        return 'bg-gray-500/20 text-gray-500';
      case 'pending':
        return 'bg-yellow-500/20 text-yellow-500';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'paid':
        return <CheckCircle className="h-4 w-4" />;
      case 'refunded':
        return <ArrowLeftRight className="h-4 w-4" />;
      case 'expired':
        return <XCircle className="h-4 w-4" />;
      case 'pending':
        return <Clock className="h-4 w-4" />;
      default:
        return <AlertCircle className="h-4 w-4" />;
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-xl">
            <DollarSign className="h-5 w-5 text-green-500" />
            Escrow Management
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {escrows.length}{' '}
            {escrows.length === 1 ? 'escrow payment' : 'escrow payments'}
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => fetchEscrows(true)}
            disabled={isRefreshing}
            className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-medium text-sm transition-colors hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {(
          ['all', 'pending', 'paid', 'refunded', 'expired'] as StatusFilter[]
        ).map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={cn(
              'rounded px-3 py-1.5 font-medium text-sm transition-colors',
              statusFilter === status
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {/* Escrows List */}
      {escrows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card py-12 text-center text-muted-foreground">
          <DollarSign className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>No escrow payments found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {escrows.map((escrow) => (
            <div
              key={escrow.id}
              className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-3">
                    <Avatar
                      src={escrow.recipient.profileImageUrl ?? undefined}
                      alt={
                        escrow.recipient.displayName ||
                        escrow.recipient.username ||
                        'User'
                      }
                      size="sm"
                    />
                    <div>
                      <div className="font-medium">
                        {escrow.recipient.displayName ||
                          escrow.recipient.username ||
                          'Unknown User'}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        Admin:{' '}
                        {escrow.admin.displayName ||
                          escrow.admin.username ||
                          'Unknown'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Amount: </span>
                      <span className="font-semibold text-green-600">
                        {formatCurrency(escrow.amountUSD)}
                      </span>
                    </div>
                    <div
                      className={cn(
                        'flex items-center gap-1 rounded px-2 py-0.5 text-xs',
                        getStatusColor(escrow.status)
                      )}
                    >
                      {getStatusIcon(escrow.status)}
                      {escrow.status.charAt(0).toUpperCase() +
                        escrow.status.slice(1)}
                    </div>
                  </div>

                  {escrow.reason && (
                    <div className="text-muted-foreground text-sm">
                      <span className="font-medium">Reason: </span>
                      {escrow.reason}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-4 text-muted-foreground text-xs">
                    <div>
                      <span className="font-medium">Created: </span>
                      {formatDate(escrow.createdAt)}
                    </div>
                    {escrow.paymentTxHash && (
                      <div>
                        <span className="font-medium">Payment TX: </span>
                        <a
                          href={`https://basescan.org/tx/${escrow.paymentTxHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-primary hover:underline"
                        >
                          {escrow.paymentTxHash.slice(0, 10)}...
                          {escrow.paymentTxHash.slice(-8)}
                        </a>
                      </div>
                    )}
                    {escrow.refundTxHash && (
                      <div>
                        <span className="font-medium">Refund TX: </span>
                        <a
                          href={`https://basescan.org/tx/${escrow.refundTxHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-primary hover:underline"
                        >
                          {escrow.refundTxHash.slice(0, 10)}...
                          {escrow.refundTxHash.slice(-8)}
                        </a>
                      </div>
                    )}
                    {escrow.refundedAt && escrow.refundedByUser && (
                      <div>
                        <span className="font-medium">Refunded by: </span>
                        {escrow.refundedByUser.displayName ||
                          escrow.refundedByUser.username ||
                          'Unknown'}{' '}
                        on {formatDate(escrow.refundedAt)}
                      </div>
                    )}
                  </div>
                </div>

                {escrow.status === 'paid' && !escrow.refundTxHash && (
                  <button
                    onClick={() => {
                      setSelectedEscrow(escrow);
                      setShowRefundModal(true);
                    }}
                    className="flex items-center gap-1 rounded bg-blue-500/20 px-3 py-1.5 font-medium text-blue-500 text-sm transition-colors hover:bg-blue-500/30"
                  >
                    <ArrowLeftRight className="h-4 w-4" />
                    Refund
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Refund Modal */}
      {showRefundModal && selectedEscrow && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
            <h2 className="mb-4 flex items-center gap-2 font-bold text-xl">
              <ArrowLeftRight className="h-5 w-5 text-blue-500" />
              Refund Escrow Payment
            </h2>

            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-3">
                <div className="text-muted-foreground text-sm">Recipient</div>
                <div className="font-medium">
                  {selectedEscrow.recipient.displayName ||
                    selectedEscrow.recipient.username ||
                    'Unknown User'}
                </div>
                <div className="mt-2 text-muted-foreground text-sm">Amount</div>
                <div className="font-semibold text-green-600">
                  {formatCurrency(selectedEscrow.amountUSD)}
                </div>
              </div>

              <div>
                <label className="mb-2 block font-medium text-sm">
                  Refund Transaction Hash{' '}
                  <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={refundTxHash}
                  onChange={(e) => setRefundTxHash(e.target.value)}
                  placeholder="0x..."
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div>
                <label className="mb-2 block font-medium text-sm">
                  Reason (optional)
                </label>
                <textarea
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="Reason for refund..."
                  rows={3}
                  className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowRefundModal(false);
                    setSelectedEscrow(null);
                    setRefundTxHash('');
                    setRefundReason('');
                  }}
                  disabled={isRefunding}
                  className="flex-1 rounded-lg bg-muted px-4 py-2 text-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleRefund}
                  disabled={isRefunding || !refundTxHash.trim()}
                  className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-500 px-4 py-2 text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
                >
                  {isRefunding ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <ArrowLeftRight className="h-4 w-4" />
                      Refund Payment
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
