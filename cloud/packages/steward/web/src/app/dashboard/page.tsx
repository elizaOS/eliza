"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ChainBadge } from "@/components/chain-badge";
import { StatusBadge } from "@/components/status-badge";
import { steward } from "@/lib/api";
import { getChainSymbol } from "@/lib/chains";
import type { AgentIdentity, TxRecord } from "@/lib/steward-client";
import { formatDate, formatWei, shortenAddress } from "@/lib/utils";

const easeOutQuart: [number, number, number, number] = [0.25, 1, 0.5, 1];

interface DashboardData {
  agents: AgentIdentity[];
  recentTx: (TxRecord & { agentName?: string })[];
  pendingCount: number;
}

export default function DashboardOverview() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  async function loadDashboard() {
    try {
      setLoading(true);
      setError(null);
      const agentsList = await steward.listAgents();
      const allTx: (TxRecord & { agentName?: string })[] = [];

      for (const agent of agentsList.slice(0, 20)) {
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
          /* agent may not have history */
        }
      }

      allTx.sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime(),
      );

      setData({
        agents: agentsList,
        recentTx: allTx.slice(0, 12),
        pendingCount: allTx.filter((tx) => tx.status === "pending").length,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="h-8 w-48 bg-bg-surface animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-bg p-8 h-28 animate-pulse" />
          ))}
        </div>
        <div className="h-64 bg-bg-surface animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center">
        <p className="text-text-tertiary text-sm mb-2">Connection failed</p>
        <p className="text-text-secondary text-xs mb-6 font-mono">{error}</p>
        <button
          onClick={loadDashboard}
          className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  const { agents, recentTx, pendingCount } = data!;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="space-y-10"
    >
      {/* Header */}
      <div>
        <h1 className="font-display text-2xl font-700 tracking-tight">Overview</h1>
        <p className="text-sm text-text-tertiary mt-1">Agent wallet infrastructure</p>
      </div>

      {/* Key Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border">
        {[
          { label: "Agents", value: agents.length },
          {
            label: "Pending Approvals",
            value: pendingCount,
            accent: pendingCount > 0,
          },
          { label: "Recent Transactions", value: recentTx.length },
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08, ease: easeOutQuart, duration: 0.4 }}
            className="bg-bg p-6 md:p-8"
          >
            <div className="text-xs text-text-tertiary tracking-wider uppercase">{stat.label}</div>
            <div
              className={`font-display text-3xl font-700 mt-2 tabular-nums ${
                stat.accent ? "text-amber-400" : ""
              }`}
            >
              {stat.value}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Pending banner */}
      <AnimatePresence>
        {pendingCount > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <Link
              href="/dashboard/approvals"
              className="flex items-center justify-between border border-amber-400/20 bg-amber-400/5 px-6 py-4 hover:bg-amber-400/10 transition-colors group"
            >
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="text-sm text-text">
                  {pendingCount} transaction{pendingCount !== 1 && "s"} awaiting review
                </span>
              </div>
              <span className="text-xs text-text-tertiary group-hover:text-text-secondary transition-colors">
                Review
              </span>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Activity Feed */}
      <div>
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display text-lg font-600">Recent Activity</h2>
          <Link
            href="/dashboard/transactions"
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            All transactions
          </Link>
        </div>

        {recentTx.length === 0 ? (
          <div className="py-16 text-center border border-border-subtle">
            <p className="text-text-tertiary text-sm">No transactions yet</p>
            <p className="text-text-tertiary text-xs mt-1">Create an agent to get started</p>
            <Link
              href="/dashboard/agents"
              className="inline-block mt-4 text-xs px-4 py-2 bg-accent text-bg hover:bg-accent-hover transition-colors"
            >
              Create Agent
            </Link>
          </div>
        ) : (
          <div className="border-t border-border-subtle">
            {recentTx.map((tx, i) => (
              <motion.div
                key={tx.id || i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.04, duration: 0.3 }}
                className="flex items-center justify-between py-3.5 border-b border-border-subtle hover:bg-bg-elevated/30 transition-colors px-2 -mx-2"
              >
                <div className="flex items-center gap-4 min-w-0">
                  <StatusBadge status={tx.status} />
                  <ChainBadge chainId={tx.request?.chainId || tx.chainId || 8453} compact />
                  <Link
                    href={`/dashboard/agents/${tx.agentId}`}
                    className="text-sm text-text hover:text-accent transition-colors truncate"
                  >
                    {tx.agentName || tx.agentId}
                  </Link>
                  <span className="text-text-tertiary text-xs hidden sm:inline">to</span>
                  <span className="font-mono text-xs text-text-tertiary hidden sm:inline">
                    {shortenAddress(tx.request?.to || tx.toAddress || "0x0", 4)}
                  </span>
                </div>
                <div className="flex items-center gap-6 flex-shrink-0">
                  <span className="text-sm tabular-nums text-text-secondary">
                    {formatWei(
                      tx.request?.value || tx.value || "0",
                      getChainSymbol(tx.request?.chainId || tx.chainId || 8453),
                    )}
                  </span>
                  <span className="text-xs text-text-tertiary hidden md:inline">
                    {tx.createdAt ? formatDate(tx.createdAt) : ""}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-border">
        <Link
          href="/dashboard/agents"
          className="bg-bg p-6 hover:bg-bg-elevated transition-colors group"
        >
          <div className="text-sm font-display font-600 group-hover:text-accent transition-colors">
            Manage Agents
          </div>
          <div className="text-xs text-text-tertiary mt-1">
            Create wallets, configure policies, view activity
          </div>
        </Link>
        <Link
          href="/dashboard/approvals"
          className="bg-bg p-6 hover:bg-bg-elevated transition-colors group"
        >
          <div className="text-sm font-display font-600 group-hover:text-accent transition-colors">
            Approval Queue
          </div>
          <div className="text-xs text-text-tertiary mt-1">
            Review and approve pending transactions
          </div>
        </Link>
      </div>
    </motion.div>
  );
}
