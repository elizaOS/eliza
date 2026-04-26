/**
 * Approval queue — shows pending transactions that need manual approval.
 * Polls every 10 seconds for new items.
 */

import { Button, PagePanel, Spinner } from "@elizaos/ui";
import { Check, Clock, Copy, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatWeiValue, getChainName, truncateAddress } from "./chain-utils";
import type {
  StewardApprovalActionResponse,
  StewardPendingApproval,
  StewardPolicyResult,
} from "./types/steward";

interface ApprovalQueueProps {
  getStewardPending: () => Promise<StewardPendingApproval[]>;
  approveStewardTx: (txId: string) => Promise<StewardApprovalActionResponse>;
  rejectStewardTx: (
    txId: string,
    reason?: string,
  ) => Promise<StewardApprovalActionResponse>;
  copyToClipboard: (text: string) => Promise<void>;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  onPendingCountChange?: (count: number) => void;
  embedded?: boolean;
  refreshKey?: number | string;
}

const POLL_INTERVAL_MS = 10_000;

export function ApprovalQueue({
  getStewardPending,
  approveStewardTx,
  rejectStewardTx,
  copyToClipboard,
  setActionNotice,
  onPendingCountChange,
  embedded = false,
  refreshKey,
}: ApprovalQueueProps) {
  const [items, setItems] = useState<StewardPendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const [rejectDialogTxId, setRejectDialogTxId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const prevCountRef = useRef(0);

  const loadData = useCallback(async () => {
    try {
      const data = await getStewardPending();
      const pending = Array.isArray(data) ? data : [];
      setItems(pending);
      setError(null);

      // Toast when new items arrive (check BEFORE updating ref)
      const prevCount = prevCountRef.current;
      if (pending.length > prevCount && prevCount > 0) {
        setActionNotice(
          `${pending.length - prevCount} new approval${pending.length - prevCount > 1 ? "s" : ""} pending`,
          "info",
          3000,
        );
      }

      // Notify parent of count changes (update ref AFTER toast check)
      if (pending.length !== prevCount) {
        prevCountRef.current = pending.length;
        onPendingCountChange?.(pending.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, [getStewardPending, onPendingCountChange, setActionNotice]);

  // Initial load + polling
  useEffect(() => {
    void loadData();
    const interval = setInterval(() => void loadData(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    if (typeof refreshKey === "undefined") {
      return;
    }
    setLoading(true);
    void loadData();
  }, [loadData, refreshKey]);

  const handleApprove = useCallback(
    async (txId: string) => {
      setActionInFlight(txId);
      try {
        const result = await approveStewardTx(txId);
        if (result.ok !== false) {
          setActionNotice("Transaction approved", "success", 3000);
          setItems((prev) =>
            prev.filter((item) => item.transaction.id !== txId),
          );
          onPendingCountChange?.(items.length - 1);
        } else {
          setActionNotice(result.error ?? "Approval failed", "error", 4000);
        }
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Approval failed",
          "error",
          4000,
        );
      } finally {
        setActionInFlight(null);
      }
    },
    [approveStewardTx, setActionNotice, onPendingCountChange, items.length],
  );

  const handleReject = useCallback(
    async (txId: string, reason?: string) => {
      setActionInFlight(txId);
      try {
        const result = await rejectStewardTx(txId, reason);
        if (result.ok !== false) {
          setActionNotice("Transaction rejected", "info", 3000);
          setItems((prev) =>
            prev.filter((item) => item.transaction.id !== txId),
          );
          onPendingCountChange?.(items.length - 1);
        } else {
          setActionNotice(result.error ?? "Rejection failed", "error", 4000);
        }
      } catch (err) {
        setActionNotice(
          err instanceof Error ? err.message : "Rejection failed",
          "error",
          4000,
        );
      } finally {
        setActionInFlight(null);
        setRejectDialogTxId(null);
        setRejectReason("");
      }
    },
    [rejectStewardTx, setActionNotice, onPendingCountChange, items.length],
  );

  const handleCopy = useCallback(
    async (text: string, label: string) => {
      await copyToClipboard(text);
      setActionNotice(`${label} copied`, "success", 2000);
    },
    [copyToClipboard, setActionNotice],
  );

  const formatTime = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diff = now.getTime() - d.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch {
      return dateStr;
    }
  };

  const getPolicyReasons = (policyResults: StewardPolicyResult[]): string[] => {
    if (!Array.isArray(policyResults)) return [];
    return policyResults
      .filter(
        (r) => r.reason && (r.status === "rejected" || r.status === "pending"),
      )
      .map((r) => r.reason as string)
      .filter(Boolean);
  };

  return (
    <div className={embedded ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
      {error ? (
        <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>
      ) : null}

      {loading && items.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-12">
          <Spinner className="h-5 w-5 text-muted" />
          <span className="ml-3 text-sm text-muted">
            Checking for pending approvals…
          </span>
        </div>
      ) : null}

      {!loading && items.length === 0 && !error ? (
        <PagePanel.Empty
          variant={embedded ? "workspace" : "panel"}
          title="No pending approvals"
        />
      ) : null}

      {items.length > 0 ? (
        <PagePanel.Toolbar className="justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-txt">Pending</span>
            <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-accent px-1.5 py-0.5 text-2xs font-bold text-accent-fg">
              {items.length}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-xl px-3 text-xs"
            onClick={() => {
              setLoading(true);
              void loadData();
            }}
            disabled={loading}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </PagePanel.Toolbar>
      ) : null}

      {/* Approval cards */}
      <div className="space-y-3">
        {items.map((item) => {
          const tx = item.transaction;
          const reasons = getPolicyReasons(tx.policyResults ?? []);
          const isProcessing = actionInFlight === tx.id;

          return (
            <div
              key={item.queueId}
              className={`rounded-3xl border border-border/18 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--card)_92%,transparent),color-mix(in_srgb,var(--bg)_98%,transparent))] px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] transition-opacity ${
                isProcessing ? "opacity-60 pointer-events-none" : ""
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1 space-y-2">
                  {/* Time + chain */}
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Clock className="h-3 w-3" />
                    <span>{formatTime(item.requestedAt)}</span>
                    <span className="rounded-full border border-border/30 bg-card/60 px-2 py-0.5 text-2xs font-medium">
                      {getChainName(tx.request?.chainId ?? 0)}
                    </span>
                  </div>

                  {/* Destination + amount */}
                  <div className="flex flex-wrap items-center gap-3">
                    <div>
                      <span className="text-2xs uppercase tracking-wider text-muted/60">
                        To
                      </span>
                      <button
                        type="button"
                        className="flex items-center gap-1 font-mono text-sm text-txt hover:text-accent transition-colors cursor-pointer"
                        onClick={() =>
                          void handleCopy(tx.request?.to ?? "", "Address")
                        }
                        title={tx.request?.to}
                      >
                        {truncateAddress(tx.request?.to ?? "")}
                        <Copy className="h-3 w-3 opacity-40" />
                      </button>
                    </div>
                    <div>
                      <span className="text-2xs uppercase tracking-wider text-muted/60">
                        Amount
                      </span>
                      <p className="text-sm font-semibold text-txt">
                        {formatWeiValue(
                          tx.request?.value ?? "0",
                          tx.request?.chainId ?? 8453,
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Policy reasons */}
                  {reasons.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-2xs uppercase tracking-wider text-muted/60">
                        Policy reason
                      </span>
                      {reasons.map((reason) => (
                        <p
                          key={reason}
                          className="rounded-lg border border-status-warning/15 bg-status-warning-bg px-2.5 py-1.5 text-xs text-status-warning"
                        >
                          {reason}
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 sm:flex-col sm:items-end">
                  {isProcessing ? (
                    <Spinner className="h-5 w-5 text-muted" />
                  ) : (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        className="h-9 rounded-xl bg-ok px-4 text-xs font-semibold text-white shadow-sm hover:bg-ok"
                        onClick={() => void handleApprove(tx.id)}
                      >
                        <Check className="h-3.5 w-3.5" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-9 rounded-xl border-status-danger/30 px-4 text-xs font-semibold text-status-danger hover:bg-status-danger-bg hover:text-status-danger"
                        onClick={() => setRejectDialogTxId(tx.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Reject reason dialog inline */}
              {rejectDialogTxId === tx.id && (
                <div className="mt-3 flex items-end gap-2 border-t border-border/20 pt-3">
                  <div className="flex-1">
                    <label className="block text-2xs font-semibold uppercase tracking-wider text-muted/60 mb-1">
                      Rejection reason (optional)
                      <input
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="e.g., Unauthorized recipient"
                        className="mt-1 h-9 w-full rounded-lg border border-border/40 bg-card/60 px-3 text-sm text-txt placeholder:text-muted/40 focus:border-accent/40 focus:outline-none"
                      />
                    </label>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 rounded-lg border-status-danger/30 px-3 text-xs text-status-danger hover:bg-status-danger-bg"
                    onClick={() =>
                      void handleReject(tx.id, rejectReason || undefined)
                    }
                  >
                    Confirm Reject
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 rounded-lg px-3 text-xs text-muted"
                    onClick={() => {
                      setRejectDialogTxId(null);
                      setRejectReason("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
