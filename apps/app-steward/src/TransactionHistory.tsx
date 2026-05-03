/**
 * Transaction history table — lists all transactions for the agent from Steward vault.
 */

import {
  Button,
  PagePanel,
  Spinner,
  StatusBadge,
  statusLabelForState,
  statusToneForState,
} from "@elizaos/ui";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatWeiValue,
  getChainName,
  getExplorerTxUrl,
  truncateAddress,
} from "./chain-utils";
import type { StewardTxRecord, StewardTxStatus } from "./types/steward";

interface TransactionHistoryProps {
  getStewardHistory: (opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{
    records: StewardTxRecord[];
    total: number;
    offset: number;
    limit: number;
  }>;
  copyToClipboard: (text: string) => Promise<void>;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  embedded?: boolean;
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "signed", label: "Signed" },
  { value: "broadcast", label: "Broadcast" },
  { value: "confirmed", label: "Confirmed" },
  { value: "rejected", label: "Rejected" },
  { value: "failed", label: "Failed" },
];

const CHAIN_OPTIONS: Array<{ value: number | ""; label: string }> = [
  { value: "", label: "All Chains" },
  { value: 1, label: "Ethereum" },
  { value: 8453, label: "Base" },
  { value: 56, label: "BSC" },
  { value: 137, label: "Polygon" },
  { value: 42161, label: "Arbitrum" },
  { value: 101, label: "Solana" },
];

export function TransactionHistory({
  getStewardHistory,
  copyToClipboard,
  setActionNotice,
  embedded = false,
}: TransactionHistoryProps) {
  const [records, setRecords] = useState<StewardTxRecord[]>([]);
  const [_total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [chainFilter, setChainFilter] = useState<number | "">("");
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getStewardHistory({
        status: statusFilter || undefined,
        limit: 200,
        offset: 0,
      });
      setRecords(result.records ?? []);
      setTotal(result.total ?? 0);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load transactions",
      );
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [getStewardHistory, statusFilter]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Client-side chain filter + sort
  const filtered = useMemo(() => {
    let items = records;
    if (chainFilter !== "") {
      items = items.filter((tx) => tx.request?.chainId === chainFilter);
    }
    // Sort newest first
    return [...items].sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return bTime - aTime;
    });
  }, [records, chainFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);

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
      return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className={embedded ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
      {error ? (
        <PagePanel.Notice tone="danger">{error}</PagePanel.Notice>
      ) : null}

      {loading && records.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-16">
          <Spinner className="h-5 w-5 text-muted" />
          <span className="ml-3 text-sm text-muted">Loading transactions…</span>
        </div>
      ) : null}

      {!loading && filtered.length === 0 ? (
        <PagePanel.Empty
          variant={embedded ? "workspace" : "panel"}
          title="No transactions yet"
        />
      ) : null}

      {/* Table */}
      {paginated.length > 0 && (
        <>
          <PagePanel.Toolbar>
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(0);
              }}
              className="h-9 rounded-xl border border-border/50 bg-card/80 px-3 text-sm text-txt shadow-sm focus:border-accent/40 focus:outline-none"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <select
              value={chainFilter}
              onChange={(e) => {
                setChainFilter(
                  e.target.value === "" ? "" : Number(e.target.value),
                );
                setPage(0);
              }}
              className="h-9 rounded-xl border border-border/50 bg-card/80 px-3 text-sm text-txt shadow-sm focus:border-accent/40 focus:outline-none"
            >
              {CHAIN_OPTIONS.map((opt) => (
                <option key={String(opt.value)} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-xl px-3 text-xs font-semibold"
              onClick={() => void loadData()}
              disabled={loading}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>

            <span className="ml-auto text-xs text-muted">
              {filtered.length} transaction{filtered.length !== 1 ? "s" : ""}
            </span>
          </PagePanel.Toolbar>

          <div className={embedded ? "overflow-hidden" : undefined}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/20 text-left text-xs font-semibold uppercase tracking-wider text-muted/70">
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">To</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Chain</th>
                    <th className="px-4 py-3">Tx Hash</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/10">
                  {paginated.map((tx) => (
                    <tr
                      key={tx.id}
                      className="group transition-colors hover:bg-accent/4"
                    >
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">
                        {formatTime(tx.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge
                          label={statusLabelForState(
                            tx.status as StewardTxStatus,
                          )}
                          tone={statusToneForState(
                            tx.status as StewardTxStatus,
                          )}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 font-mono text-xs text-txt hover:text-accent transition-colors cursor-pointer"
                          onClick={() =>
                            void handleCopy(tx.request?.to ?? "", "Address")
                          }
                          title={tx.request?.to}
                        >
                          {truncateAddress(tx.request?.to ?? "")}
                          <Copy className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs font-medium text-txt">
                        {formatWeiValue(
                          tx.request?.value ?? "0",
                          tx.request?.chainId ?? 8453,
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-muted">
                        {getChainName(tx.request?.chainId ?? 0)}
                      </td>
                      <td className="px-4 py-3">
                        {tx.txHash ? (
                          <a
                            href={
                              getExplorerTxUrl(
                                tx.request?.chainId ?? 8453,
                                tx.txHash,
                              ) ?? "#"
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:text-accent/80 transition-colors"
                            title={tx.txHash}
                          >
                            {truncateAddress(tx.txHash, 4)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-muted/50">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {pageCount > 1 && (
              <div className="flex items-center justify-between border-t border-border/20 px-4 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="h-8 rounded-lg px-3 text-xs"
                >
                  Previous
                </Button>
                <span className="text-xs text-muted">
                  Page {page + 1} of {pageCount}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  className="h-8 rounded-lg px-3 text-xs"
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
