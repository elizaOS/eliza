"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { text: string; dot: string }> = {
  signed: { text: "text-emerald-400", dot: "bg-emerald-500" },
  confirmed: { text: "text-emerald-400", dot: "bg-emerald-500" },
  approved: { text: "text-emerald-400", dot: "bg-emerald-500" },
  broadcast: { text: "text-blue-400", dot: "bg-blue-500" },
  pending: { text: "text-[#FF5800]", dot: "bg-[#FF5800]" },
  failed: { text: "text-red-400", dot: "bg-red-500" },
  rejected: { text: "text-red-400", dot: "bg-red-500" },
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

// ── Main Component ───────────────────────────────────────────────────────────

interface ElizaTransactionsSectionProps {
  agentId: string;
}

export function ElizaTransactionsSection({ agentId }: ElizaTransactionsSectionProps) {
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
        const msg = err instanceof Error ? err.message : "Failed to load transactions";
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
        <span className="font-mono text-[10px] tracking-[0.15em] text-white/30 shrink-0">
          FILTER:
        </span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setStatusFilter(f.value)}
            className={`shrink-0 px-3 py-1.5 font-mono text-[10px] tracking-wide border transition-colors ${
              statusFilter === f.value
                ? "text-[#FF5800] border-[#FF5800]/30 bg-[#FF5800]/5"
                : "text-white/40 border-white/10 hover:text-white/70 hover:border-white/20"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="border border-white/10 bg-black/40 overflow-hidden">
        {/* Header */}
        <div className="hidden sm:grid grid-cols-[140px_1fr_1fr_100px_1fr] gap-px bg-white/5">
          {["DATE", "TO", "AMOUNT", "STATUS", "TX HASH"].map((h) => (
            <div
              key={h}
              className="bg-black/60 px-3 py-2 font-mono text-[9px] tracking-[0.15em] text-white/30"
            >
              {h}
            </div>
          ))}
        </div>

        {loading && (
          <div className="flex items-center justify-center py-12 gap-3">
            <div className="w-4 h-4 rounded-full border-2 border-[#FF5800]/30 border-t-[#FF5800] animate-spin" />
            <span className="font-mono text-xs text-white/30">Loading transactions…</span>
          </div>
        )}

        {!loading && error && (
          <div className="p-6 text-center space-y-2">
            <p className="font-mono text-xs text-red-400">{error}</p>
            <button
              type="button"
              onClick={() => fetchRecords(0, false)}
              className="font-mono text-[11px] text-[#FF5800] hover:text-[#FF5800]/70 transition-colors"
            >
              RETRY
            </button>
          </div>
        )}

        {!loading && !error && records.length === 0 && (
          <div className="p-8 text-center">
            <p className="font-mono text-sm text-white/30">NO TRANSACTIONS</p>
            <p className="font-mono text-xs text-white/20 mt-1">
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
                className="grid grid-cols-1 sm:grid-cols-[140px_1fr_1fr_100px_1fr] gap-px bg-white/5 border-t border-white/5 first:border-t-0"
              >
                <div className="bg-black/60 px-3 py-2.5">
                  <span className="sm:hidden font-mono text-[9px] text-white/30 mr-2">DATE:</span>
                  <span className="font-mono text-[11px] text-white/70 tabular-nums">
                    {formatDate(tx.createdAt)}
                  </span>
                </div>
                <div className="bg-black/60 px-3 py-2.5 flex items-center">
                  <span className="sm:hidden font-mono text-[9px] text-white/30 mr-2">TO:</span>
                  {tx.request?.to ? (
                    <span className="font-mono text-[11px] text-white/70">
                      {truncate(tx.request.to)}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px] text-white/25">—</span>
                  )}
                </div>
                <div className="bg-black/60 px-3 py-2.5">
                  <span className="sm:hidden font-mono text-[9px] text-white/30 mr-2">AMOUNT:</span>
                  <span className="font-mono text-[11px] text-white/70 tabular-nums">
                    {formatValue(tx.request?.value)}
                  </span>
                </div>
                <div className="bg-black/60 px-3 py-2.5 flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                  <span className={`font-mono text-[10px] tracking-wide ${colors.text}`}>
                    {tx.status.toUpperCase()}
                  </span>
                </div>
                <div className="bg-black/60 px-3 py-2.5">
                  <span className="sm:hidden font-mono text-[9px] text-white/30 mr-2">HASH:</span>
                  {tx.txHash ? (
                    <a
                      href={explorerUrl(tx.txHash, tx.request?.chainId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[11px] text-[#FF5800] hover:text-[#FF5800]/70 transition-colors inline-flex items-center gap-1"
                    >
                      {truncate(tx.txHash)}
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25"
                        />
                      </svg>
                    </a>
                  ) : (
                    <span className="font-mono text-[11px] text-white/25">—</span>
                  )}
                </div>
              </div>
            );
          })}

        {!loading && records.length < total && (
          <div className="p-3 bg-black/60 border-t border-white/5 text-center">
            <button
              type="button"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-2 px-4 py-2 font-mono text-[11px] tracking-wide
                text-[#FF5800] hover:text-[#FF5800]/70 border border-[#FF5800]/20 hover:border-[#FF5800]/40
                transition-colors disabled:opacity-40"
            >
              {loadingMore ? (
                <>
                  <div className="w-3 h-3 rounded-full border border-[#FF5800]/30 border-t-[#FF5800] animate-spin" />
                  LOADING…
                </>
              ) : (
                <>
                  LOAD MORE{" "}
                  <span className="text-white/30">
                    ({records.length}/{total})
                  </span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
