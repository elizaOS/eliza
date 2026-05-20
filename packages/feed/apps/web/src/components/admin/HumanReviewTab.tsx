/**
 * Human review tab component for reviewing moderation appeals.
 *
 * Displays appeals that need human review after users have staked on them.
 * Shows appeal details, user information, ban history, and provides approve/deny
 * functionality. Includes user statistics and transaction hash tracking.
 *
 * Features:
 * - Appeals list display
 * - Appeal details
 * - User statistics
 * - Approve/deny functionality
 * - Transaction hash display
 * - Loading states
 * - Error handling
 *
 * @returns Human review tab element
 */
'use client';

import { cn, formatDateTime, type JsonValue } from '@babylon/shared';
import { AlertCircle, DollarSign } from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Avatar } from '@/components/shared/Avatar';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

/**
 * Appeal structure for human review tab.
 */
interface Appeal {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  bannedAt: Date | null;
  bannedReason: string | null;
  bannedBy: string | null;
  isScammer: boolean;
  isCSAM: boolean;
  appealCount: number;
  appealStaked: boolean;
  appealStakeAmount: number | null;
  appealStakeTxHash: string | null;
  appealSubmittedAt: Date | null;
  falsePositiveHistory: Array<Record<string, JsonValue>> | null;
  earnedPoints: number;
  totalDeposited: number;
  totalWithdrawn: number;
  lifetimePnL: number;
}

export function HumanReviewTab() {
  const [appeals, setAppeals] = useState<Appeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAppeal, setSelectedAppeal] = useState<Appeal | null>(null);
  const [showActionModal, setShowActionModal] = useState(false);

  const fetchAppeals = useCallback(async () => {
    const response = await fetch(apiUrl('/api/admin/moderation/human-review'));
    if (!response.ok) {
      toast.error('Failed to load appeals');
      setLoading(false);
      return;
    }
    const data = await response.json();
    setAppeals(data.appeals || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAppeals();
  }, [fetchAppeals]);

  const handleAction = async (
    userId: string,
    action: 'approve' | 'deny',
    reasoning: string
  ) => {
    const response = await fetch(
      `/api/admin/moderation/human-review/${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reasoning }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      toast.error(error.message || 'Failed to process appeal');
      return;
    }

    setShowActionModal(false);
    setSelectedAppeal(null);
    fetchAppeals();
  };

  const formatDate = (date: Date | null) =>
    date ? formatDateTime(date) : 'N/A';

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 font-bold text-2xl">Human Review Queue</h2>
        <p className="text-muted-foreground">
          Appeals that require human review after staking $10. Review carefully
          and decide whether to restore the account or confirm permanent ban.
        </p>
      </div>

      {appeals.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <AlertCircle className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p>No appeals pending human review</p>
        </div>
      ) : (
        <div className="space-y-4">
          {appeals.map((appeal) => (
            <div
              key={appeal.id}
              className="rounded-lg border border-border bg-card p-6 transition-colors hover:border-primary/50"
            >
              <div className="flex items-start gap-4">
                <Avatar
                  src={appeal.profileImageUrl || undefined}
                  alt={appeal.displayName || appeal.username || 'User'}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  <div className="mb-3 flex items-center gap-3">
                    <h3 className="font-semibold text-lg">
                      {appeal.displayName || appeal.username || appeal.id}
                    </h3>
                    {appeal.isScammer && (
                      <span className="rounded bg-red-500/20 px-2 py-1 text-red-500 text-xs">
                        Scammer
                      </span>
                    )}
                    {appeal.isCSAM && (
                      <span className="rounded bg-red-500/20 px-2 py-1 text-red-500 text-xs">
                        CSAM
                      </span>
                    )}
                  </div>

                  <div className="mb-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                    <div>
                      <div className="text-muted-foreground">Banned At</div>
                      <div className="font-medium">
                        {formatDate(appeal.bannedAt)}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Stake Amount</div>
                      <div className="flex items-center gap-1 font-medium">
                        <DollarSign className="h-4 w-4" />
                        {appeal.appealStakeAmount?.toFixed(2) || 'N/A'}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Earned Points</div>
                      <div className="font-medium">{appeal.earnedPoints}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">
                        Total Deposited
                      </div>
                      <div className="font-medium">
                        ${Number(appeal.totalDeposited).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="mb-4">
                    <div className="mb-1 text-muted-foreground text-sm">
                      Ban Reason
                    </div>
                    <div className="rounded bg-muted/50 p-2 text-sm">
                      {appeal.bannedReason || 'No reason provided'}
                    </div>
                  </div>

                  {(() => {
                    const history = appeal.falsePositiveHistory;
                    if (
                      history &&
                      Array.isArray(history) &&
                      history.length > 0
                    ) {
                      return (
                        <div className="mb-4">
                          <div className="mb-1 text-muted-foreground text-sm">
                            False Positive History
                          </div>
                          <div className="rounded bg-yellow-500/10 p-2 text-sm">
                            This user has {history.length} previous false
                            positive(s)
                          </div>
                        </div>
                      );
                    }
                    return null;
                  })()}

                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setSelectedAppeal(appeal);
                        setShowActionModal(true);
                      }}
                      className="rounded-lg bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90"
                    >
                      Review Appeal
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showActionModal && selectedAppeal && (
        <ActionModal
          appeal={selectedAppeal}
          onClose={() => {
            setShowActionModal(false);
            setSelectedAppeal(null);
          }}
          onAction={handleAction}
        />
      )}
    </div>
  );
}

interface ActionModalProps {
  appeal: Appeal;
  onClose: () => void;
  onAction: (
    userId: string,
    action: 'approve' | 'deny',
    reasoning: string
  ) => void;
}

function ActionModal({ appeal, onAction, onClose }: ActionModalProps) {
  const [action, setAction] = useState<'approve' | 'deny'>('approve');
  const [reasoning, setReasoning] = useState('');
  const [isSubmitting, startSubmit] = useTransition();

  const handleSubmit = () => {
    if (!reasoning.trim()) {
      toast.error('Please provide reasoning for your decision');
      return;
    }

    startSubmit(() => {
      onAction(appeal.id, action, reasoning);
    });
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6">
        <h2 className="mb-4 font-bold text-xl">Review Appeal</h2>

        <div className="mb-4">
          <div className="mb-2 text-muted-foreground text-sm">User</div>
          <div className="flex items-center gap-2">
            <Avatar
              src={appeal.profileImageUrl || undefined}
              alt={appeal.displayName || appeal.username || 'User'}
              size="sm"
            />
            <span className="font-medium">
              {appeal.displayName || appeal.username || appeal.id}
            </span>
          </div>
        </div>

        <div className="mb-4">
          <label className="mb-2 block font-medium text-sm">Decision</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as 'approve' | 'deny')}
            className="w-full rounded-lg border border-border bg-background px-3 py-2"
          >
            <option value="approve">
              Approve - Restore Account (False Positive)
            </option>
            <option value="deny">Deny - Confirm Permanent Ban</option>
          </select>
        </div>

        <div className="mb-4">
          <label className="mb-2 block font-medium text-sm">Reasoning</label>
          <textarea
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
            placeholder="Explain your decision..."
            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2"
            rows={6}
          />
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="flex-1 rounded-lg bg-muted px-4 py-2 transition-colors hover:bg-muted/80"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || !reasoning.trim()}
            className={cn(
              'flex-1 rounded-lg px-4 py-2 transition-colors',
              action === 'approve'
                ? 'bg-green-500 text-white hover:bg-green-600'
                : 'bg-red-500 text-white hover:bg-red-600',
              'disabled:opacity-50'
            )}
          >
            {isSubmitting
              ? 'Processing...'
              : action === 'approve'
                ? 'Approve Appeal'
                : 'Deny Appeal'}
          </button>
        </div>
      </div>
    </div>
  );
}
