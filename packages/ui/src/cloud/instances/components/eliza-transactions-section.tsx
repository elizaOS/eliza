"use client";

/**
 * Transactions section of the cloud agent-instance detail: the agent's on-chain
 * transaction history.
 */
import { ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";

interface TxRequest {
  to?: string;
  value?: string;
  chainId?: number;
  data?: string;
}

interface StewardTxRecord {
  id: string;
  status: string;
  createdAt: string;
  txHash?: string;
  request?: TxRequest;
}

const STATUS_COLORS: Record<string, { text: string; dot: string }> = {
  signed: { text: "text-status-success", dot: "bg-status-success" },
  confirmed: { text: "text-status-success", dot: "bg-status-success" },
  approved: { text: "text-status-success", dot: "bg-status-success" },
  broadcast: { text: "text-muted-strong", dot: "bg-muted" },
  pending: { text: "text-accent", dot: "bg-accent" },
  failed: { text: "text-destructive", dot: "bg-destructive" },
  rejected: { text: "text-destructive", dot: "bg-destructive" },
};

const EXPLORER_URLS: Record<number, string> = {
  8453: "https://basescan.org/tx/",
  84532: "https://sepolia.basescan.org/tx/",
  1: "https://etherscan.io/tx/",
  56: "https://bscscan.com/tx/",
};

function explorerUrl(txHash: string, chainId?: number) {
  return `${EXPLORER_URLS[chainId ?? 8453] ?? EXPLORER_URLS[8453]}${txHash}`;
}

function truncate(addr: string) {
  if (!addr || addr.length < 10) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatDate(s: string) {
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function formatValue(value?: string) {
  if (!value || value === "0") return "0 ETH";
  try {
    const eth = Number(BigInt(value)) / 1e18;
    if (eth === 0) return "0 ETH";
    if (eth < 0.0001) return "<0.0001 ETH";
    return `${eth.toFixed(4)} ETH`;
  } catch {
    return value;
  }
}

const STATUS_FILTERS = [
  { value: "", label: "ALL" },
  { value: "pending", label: "PENDING" },
  { value: "signed", label: "SIGNED" },
  { value: "confirmed", label: "CONFIRMED" },
  { value: "failed", label: "FAILED" },
  { value: "rejected", label: "DENIED" },
];

const PAGE_SIZE = 20;

interface ElizaTransactionsSectionProps {
  agentId: string;
}

export function ElizaTransactionsSection({
  agentId,
}: ElizaTransactionsSectionProps) {
  const [records, setRecords] = useState<StewardTxRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const mountedRef = useRef(true);

  const base = `/api/v1/eliza/agents/${agentId}/api/wallet`;

  const fetchRecords = useCallback(
    async (newOffset: number, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(newOffset),
        });
        if (statusFilter) params.set("status", statusFilter);
        const res = await fetch(`${base}/steward-tx-records?${params}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const result = await res.json();
        if (!mountedRef.current) return;
        const incoming = Array.isArray(result.records)
          ? result.records
          : Array.isArray(result)
            ? result
            : [];
        if (append) {
          setRecords((prev) => [...prev, ...incoming]);
        } else {
          setRecords(incoming);
        }
        setTotal(result.total ?? incoming.length);
        setOffset(newOffset);
      } catch (err) {
        if (!mountedRef.current) return;
        const msg =
          err instanceof Error ? err.message : "Failed to load transactions";
        setError(
          msg.includes("503") || msg.includes("not configured")
            ? "No transaction history available."
            : msg,
        );
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [base, statusFilter],
  );

  useEffect(() => {
    mountedRef.current = true;
    fetchRecords(0, false);
    return () => {
      mountedRef.current = false;
    };
  }, [fetchRecords]);

  const handleLoadMore = useCallback(() => {
    fetchRecords(offset + PAGE_SIZE, true);
  }, [fetchRecords, offset]);

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex items-center gap-2 overflow-x-auto">
        <span className="font-mono text-2xs tracking-[0.15em] text-muted shrink-0">
          FILTER:
        </span>
        {STATUS_FILTERS.map((f) => (
          <Button
            variant="ghost"
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={`shrink-0 min-h-touch px-3 py-1.5 font-mono text-2xs tracking-wide border transition-colors ${
              statusFilter === f.value
                ? "text-txt-strong border-accent bg-accent-subtle"
                : "text-muted border-border hover:text-txt hover:border-border-strong"
            }`}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Table */}
      <div className="border border-border bg-card overflow-hidden">
        {/* Header */}
        <div className="hidden sm:grid grid-cols-[140px_1fr_1fr_100px_1fr] gap-px bg-border">
          {["DATE", "TO", "AMOUNT", "STATUS", "TX HASH"].map((h) => (
            <div
              key={h}
              className="bg-card px-3 py-2 font-mono text-3xs tracking-[0.15em] text-muted"
            >
              {h}
            </div>
          ))}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-12 gap-3">
            <Loader2
              className="h-4 w-4 animate-spin text-accent"
              strokeWidth={2}
              aria-hidden="true"
            />
            <span className="font-mono text-xs text-muted">
              Loading transactions…
            </span>
          </div>
        )}

        {!loading && error && (
          <div className="p-6 text-center space-y-2">
            <p className="font-mono text-xs text-destructive">{error}</p>
            <Button
              variant="ghost"
              type="button"
              onClick={() => fetchRecords(0, false)}
              className="min-h-touch font-mono text-xs-tight text-muted hover:text-txt transition-colors"
            >
              RETRY
            </Button>
          </div>
        )}

        {!loading && !error && records.length === 0 && (
          <div className="p-8 text-center">
            <p className="font-mono text-sm text-muted">NO TRANSACTIONS</p>
            <p className="font-mono text-xs text-muted mt-1">
              {statusFilter
                ? `No transactions with status "${statusFilter}"`
                : "No transaction history found"}
            </p>
          </div>
        )}

        {!loading &&
          records.map((tx, i) => {
            const colors = STATUS_COLORS[tx.status] ?? STATUS_COLORS.signed;
            return (
              <div
                key={tx.id || `tx-${i}`}
                className="grid grid-cols-1 sm:grid-cols-[140px_1fr_1fr_100px_1fr] gap-px bg-border border-t border-border first:border-t-0"
              >
                <div className="bg-card px-3 py-2.5">
                  <span className="sm:hidden font-mono text-3xs text-muted mr-2">
                    DATE:
                  </span>
                  <span className="font-mono text-xs-tight text-muted-strong tabular-nums">
                    {formatDate(tx.createdAt)}
                  </span>
                </div>
                <div className="bg-card px-3 py-2.5 flex items-center">
                  <span className="sm:hidden font-mono text-3xs text-muted mr-2">
                    TO:
                  </span>
                  {tx.request?.to ? (
                    <span className="font-mono text-xs-tight text-muted-strong">
                      {truncate(tx.request.to)}
                    </span>
                  ) : (
                    <span className="font-mono text-xs-tight text-muted">—</span>
                  )}
                </div>
                <div className="bg-card px-3 py-2.5">
                  <span className="sm:hidden font-mono text-3xs text-muted mr-2">
                    AMOUNT:
                  </span>
                  <span className="font-mono text-xs-tight text-muted-strong tabular-nums">
                    {formatValue(tx.request?.value)}
                  </span>
                </div>
                <div className="bg-card px-3 py-2.5 flex items-center gap-1.5">
                  <span
                    className={`inline-block size-1.5 rounded-full ${colors.dot}`}
                  />
                  <span
                    className={`font-mono text-2xs tracking-wide ${colors.text}`}
                  >
                    {tx.status.toUpperCase()}
                  </span>
                </div>
                <div className="bg-card px-3 py-2.5">
                  <span className="sm:hidden font-mono text-3xs text-muted mr-2">
                    HASH:
                  </span>
                  {tx.txHash ? (
                    <a
                      href={explorerUrl(tx.txHash, tx.request?.chainId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs-tight text-muted-strong hover:text-txt transition-colors inline-flex items-center gap-1"
                    >
                      {truncate(tx.txHash)}
                      <ExternalLink
                        className="h-3 w-3"
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                    </a>
                  ) : (
                    <span className="font-mono text-xs-tight text-muted">—</span>
                  )}
                </div>
              </div>
            );
          })}

        {!loading && records.length < total && (
          <div className="p-3 bg-card border-t border-border text-center">
            <Button
              variant="ghost"
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-2 min-h-touch px-4 py-2 font-mono text-xs-tight tracking-wide
                text-accent hover:opacity-75
                transition-opacity disabled:opacity-40"
            >
              {loadingMore ? (
                <>
                  <Loader2
                    className="h-3 w-3 animate-spin"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  LOADING…
                </>
              ) : (
                <>
                  LOAD MORE{" "}
                  <span className="text-muted">
                    ({records.length}/{total})
                  </span>
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
