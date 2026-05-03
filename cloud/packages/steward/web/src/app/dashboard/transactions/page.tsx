"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChainBadge } from "@/components/chain-badge";
import { StatusBadge } from "@/components/status-badge";
import { steward } from "@/lib/api";
import { getChainSymbol, getExplorerTxLink } from "@/lib/chains";
import type { TxRecord } from "@/lib/steward-client";
import { formatDate, formatWei, shortenAddress } from "@/lib/utils";

type TxWithAgent = TxRecord & { agentName?: string };

const FILTERS = ["all", "signed", "confirmed", "pending", "rejected", "failed"] as const;

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<TxWithAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  async function loadTransactions() {
    try {
      setLoading(true);
      setError(null);
      const agents = await steward.listAgents();
      const allTx: TxWithAgent[] = [];

      for (const agent of agents) {
        try {
          const history = await steward.getHistory(agent.id);
          allTx.push(
            ...history.map((tx) => ({
              ...tx,
              agentId: agent.id,
              agentName: agent.name,
            })),
          );
        } catch {
          /* skip individual agent */
        }
      }

      allTx.sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
      );
      setTransactions(allTx);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load transactions");
    } finally {
      setLoading(false);
    }
  }

  const filtered =
    filter === "all" ? transactions : transactions.filter((tx) => tx.status === filter);

  const counts = transactions.reduce(
    (acc: Record<string, number>, tx) => {
      acc[tx.status] = (acc[tx.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="h-8 w-48 bg-bg-surface animate-pulse" />
        <div className="h-96 bg-bg-surface animate-pulse" />
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-8"
    >
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-700 tracking-tight">Transactions</h1>
        <p className="text-sm text-text-tertiary mt-1">All transactions across agents</p>
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="py-16 text-center border border-red-400/20 bg-red-400/5">
          <p className="text-text-secondary text-sm mb-1">Failed to load transactions</p>
          <p className="text-text-tertiary text-xs mb-4 font-mono">{error}</p>
          <button
            onClick={loadTransactions}
            className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-1 flex-wrap">
        {FILTERS.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`text-xs px-3 py-1.5 transition-colors ${
              filter === status
                ? "bg-bg-surface text-text"
                : "text-text-tertiary hover:text-text-secondary hover:bg-bg-elevated"
            }`}
          >
            {status === "all" ? "All" : status.charAt(0).toUpperCase() + status.slice(1)}
            <span className="ml-1 tabular-nums">
              {status === "all" ? transactions.length : counts[status] || 0}
            </span>
          </button>
        ))}
      </div>

      {/* List */}
      {error ? null : filtered.length === 0 ? (
        <div className="py-16 text-center border border-border-subtle">
          <p className="text-text-tertiary text-sm">
            {filter === "all" ? "No transactions yet" : `No ${filter} transactions`}
          </p>
          {filter === "all" && (
            <p className="text-text-tertiary text-xs mt-1">
              Transactions appear when agents start signing.
            </p>
          )}
        </div>
      ) : (
        <div className="border-t border-border-subtle">
          {/* Table header */}
          <div className="hidden md:flex items-center py-2 border-b border-border text-xs text-text-tertiary tracking-wider uppercase px-2">
            <span className="w-28">Status</span>
            <span className="w-20">Chain</span>
            <span className="flex-1">Agent</span>
            <span className="w-36">To</span>
            <span className="w-28 text-right">Value</span>
            <span className="w-36 text-right">TX Hash</span>
            <span className="w-32 text-right">Time</span>
          </div>

          {filtered.map((tx, i) => (
            <motion.div
              key={tx.id || i}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: Math.min(i * 0.03, 0.5), duration: 0.3 }}
              className="flex flex-col md:flex-row md:items-center py-3.5 border-b border-border-subtle hover:bg-bg-elevated/30 transition-colors px-2 gap-2 md:gap-0"
            >
              <div className="w-28">
                <StatusBadge status={tx.status} />
              </div>
              <div className="w-20">
                <ChainBadge chainId={tx.request?.chainId || tx.chainId || 8453} compact />
              </div>
              <div className="flex-1 min-w-0">
                <Link
                  href={`/dashboard/agents/${tx.agentId}`}
                  className="text-sm text-text hover:text-accent transition-colors truncate"
                >
                  {tx.agentName || tx.agentId}
                </Link>
              </div>
              <div className="w-36">
                <span className="font-mono text-xs text-text-tertiary">
                  {shortenAddress(tx.request?.to || tx.toAddress || "0x0", 6)}
                </span>
              </div>
              <div className="w-28 text-right">
                <span className="text-sm tabular-nums text-text-secondary">
                  {formatWei(
                    tx.request?.value || tx.value || "0",
                    getChainSymbol(tx.request?.chainId || tx.chainId || 8453),
                  )}
                </span>
              </div>
              <div className="w-36 text-right">
                {tx.txHash ? (
                  <a
                    href={
                      getExplorerTxLink(tx.request?.chainId || tx.chainId || 8453, tx.txHash) || "#"
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                  >
                    {shortenAddress(tx.txHash, 6)}
                  </a>
                ) : (
                  <span className="text-xs text-text-tertiary">&mdash;</span>
                )}
              </div>
              <div className="w-32 text-right">
                <span className="text-xs text-text-tertiary">
                  {tx.createdAt ? formatDate(tx.createdAt) : ""}
                </span>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
