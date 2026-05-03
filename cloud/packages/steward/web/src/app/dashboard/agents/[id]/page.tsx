"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ChainBadge } from "@/components/chain-badge";
import { CopyButton } from "@/components/copy-button";
import { StatusBadge } from "@/components/status-badge";
import { steward } from "@/lib/api";
import { getChainSymbol, getExplorerAddressLink, getExplorerTxLink } from "@/lib/chains";
import type { AgentIdentity, PolicyRule, TxRecord } from "@/lib/steward-client";
import { formatDate, formatWei, policyTypeLabel, shortenAddress } from "@/lib/utils";

interface BalanceInfo {
  agentId: string;
  walletAddress: string;
  balances: {
    native: string;
    nativeFormatted: string;
    chainId: number;
    symbol: string;
  };
}

// All 5 canonical policy types with sensible display defaults
const ALL_POLICY_TYPES: {
  type: string;
  defaultConfig: Record<string, unknown>;
}[] = [
  {
    type: "spending-limit",
    defaultConfig: { maxPerTx: "0", maxPerDay: "0" },
  },
  {
    type: "approved-addresses",
    defaultConfig: { addresses: [], mode: "whitelist" },
  },
  {
    type: "auto-approve-threshold",
    defaultConfig: { threshold: "0" },
  },
  {
    type: "time-window",
    defaultConfig: { allowedHours: [], allowedDays: [] },
  },
  {
    type: "rate-limit",
    defaultConfig: { maxTxPerHour: 0, maxTxPerDay: 0 },
  },
  {
    type: "allowed-chains",
    defaultConfig: { chainIds: [] },
  },
];

/** Merge API-returned policies with default stubs for any missing types */
function mergePolicies(apiPolicies: PolicyRule[]): PolicyRule[] {
  return ALL_POLICY_TYPES.map((pt, i) => {
    const existing = apiPolicies.find((p) => p.type === pt.type);
    if (existing) return existing;
    return {
      id: `default-${pt.type}-${i}`,
      type: pt.type,
      enabled: false,
      config: pt.defaultConfig,
    };
  });
}

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params?.id as string;

  const [agent, setAgent] = useState<AgentIdentity | null>(null);
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [transactions, setTransactions] = useState<TxRecord[]>([]);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"transactions" | "policies">("transactions");

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  async function loadAgent() {
    try {
      setLoading(true);
      setError(null);
      const [agentData, policyData, txData] = await Promise.all([
        steward.getAgent(agentId),
        steward.getPolicies(agentId).catch(() => [] as PolicyRule[]),
        steward.getHistory(agentId).catch(() => [] as TxRecord[]),
      ]);
      setAgent(agentData);
      setPolicies(mergePolicies(policyData));
      setTransactions(txData);

      // Fetch balance separately (non-blocking)
      try {
        const balanceData = await steward.getBalance(agentId);
        setBalance(balanceData as BalanceInfo);
      } catch {
        /* balance endpoint may not be available */
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load agent");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-8">
        <div className="h-8 w-64 bg-bg-surface animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-px bg-border">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-bg p-8 h-28 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center">
        <p className="font-display text-lg font-600 text-text-secondary">Failed to load agent</p>
        <p className="text-sm text-text-tertiary mt-2 font-mono">{error}</p>
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            onClick={loadAgent}
            className="text-xs px-4 py-2 bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
          <Link
            href="/dashboard/agents"
            className="text-xs px-4 py-2 text-text-tertiary hover:text-text-secondary transition-colors"
          >
            Back to Agents
          </Link>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="py-20 text-center">
        <p className="font-display text-lg font-600 text-text-secondary">Agent not found</p>
        <p className="text-sm text-text-tertiary mt-2">No agent with ID &ldquo;{agentId}&rdquo;</p>
        <Link
          href="/dashboard/agents"
          className="inline-block mt-6 text-xs px-4 py-2 bg-accent text-bg hover:bg-accent-hover transition-colors"
        >
          Back to Agents
        </Link>
      </div>
    );
  }

  const totalVolume = transactions.reduce((sum: bigint, tx) => {
    try {
      return sum + BigInt(tx.request?.value || tx.value || "0");
    } catch {
      return sum;
    }
  }, 0n);

  const pendingCount = transactions.filter((tx) => tx.status === "pending").length;

  const activePolicies = policies.filter((p) => p.enabled).length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-10"
    >
      {/* Breadcrumb + Header */}
      <div>
        <Link
          href="/dashboard/agents"
          className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
        >
          Agents /
        </Link>

        <div className="flex items-start justify-between mt-3">
          <div>
            <h1 className="font-display text-2xl font-700 tracking-tight">{agent.name}</h1>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <span className="text-xs text-text-tertiary">{agent.id}</span>
              {agent.platformId && (
                <>
                  <span className="text-border">|</span>
                  <span className="text-xs text-text-tertiary">{agent.platformId}</span>
                </>
              )}
              <span className="text-border">|</span>
              <div className="flex items-center gap-1">
                <span className="font-mono text-xs text-text-secondary">{agent.walletAddress}</span>
                <CopyButton text={agent.walletAddress} />
              </div>
            </div>
          </div>
          <a
            href={
              getExplorerAddressLink(
                transactions[0]?.request?.chainId || transactions[0]?.chainId || 8453,
                agent.walletAddress,
              ) || `https://basescan.org/address/${agent.walletAddress}`
            }
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-text-tertiary hover:text-text-secondary transition-colors px-3 py-1.5 border border-border hover:border-border flex-shrink-0"
          >
            Explorer ↗
          </a>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-px bg-border">
        {[
          {
            label: "Balance",
            value: balance
              ? `${balance.balances.nativeFormatted || formatWei(balance.balances.native || "0")} ${balance.balances.symbol || "ETH"}`
              : "—",
          },
          { label: "Transactions", value: transactions.length },
          {
            label: "Pending",
            value: pendingCount,
            accent: pendingCount > 0,
          },
          {
            label: "Volume",
            value: `${formatWei(totalVolume.toString())} ETH`,
          },
          {
            label: "Active Policies",
            value: `${activePolicies} / ${policies.length}`,
            accent: activePolicies === 0,
          },
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.3 }}
            className="bg-bg p-6"
          >
            <div className="text-xs text-text-tertiary tracking-wider uppercase">{stat.label}</div>
            <div
              className={`font-display text-2xl font-700 mt-2 tabular-nums ${
                stat.accent ? "text-amber-400" : ""
              }`}
            >
              {stat.value}
            </div>
          </motion.div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-subtle">
        {(["transactions", "policies"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`relative px-4 py-2.5 text-sm transition-colors ${
              activeTab === tab ? "text-text" : "text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {tab === "transactions"
              ? `Transactions (${transactions.length})`
              : `Policies (${activePolicies}/${policies.length})`}
            {activeTab === tab && (
              <motion.div
                layoutId="agent-tab-indicator"
                className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent"
                transition={{
                  type: "tween",
                  duration: 0.2,
                  ease: [0.25, 1, 0.5, 1],
                }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Transactions Tab */}
      {activeTab === "transactions" && (
        <div>
          {transactions.length === 0 ? (
            <div className="py-16 text-center border border-border-subtle">
              <p className="text-text-tertiary text-sm">No transactions for this agent yet.</p>
            </div>
          ) : (
            <div className="border-t border-border-subtle">
              {/* Column headers */}
              <div className="hidden md:flex items-center py-2 border-b border-border text-xs text-text-tertiary tracking-wider uppercase px-2">
                <span className="w-28">Status</span>
                <span className="w-20">Chain</span>
                <span className="flex-1">To</span>
                <span className="w-28 text-right">Value</span>
                <span className="w-36 text-right">TX Hash</span>
                <span className="w-32 text-right">Time</span>
              </div>
              {transactions.map((tx, i) => (
                <motion.div
                  key={tx.id || i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.03, duration: 0.3 }}
                  className="flex flex-col md:flex-row md:items-center py-3.5 border-b border-border-subtle hover:bg-bg-elevated/30 transition-colors px-2 gap-2 md:gap-0"
                >
                  <div className="w-28">
                    <StatusBadge status={tx.status} />
                  </div>
                  <div className="w-20">
                    <ChainBadge chainId={tx.request?.chainId || tx.chainId || 8453} compact />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-xs text-text-tertiary">
                      {shortenAddress(tx.request?.to || tx.toAddress || "0x0", 8)}
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
                          getExplorerTxLink(tx.request?.chainId || tx.chainId || 8453, tx.txHash) ||
                          "#"
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-accent hover:text-accent-hover transition-colors"
                        title={tx.txHash}
                      >
                        {shortenAddress(tx.txHash, 6)} ↗
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
        </div>
      )}

      {/* Policies Tab */}
      {activeTab === "policies" && (
        <div className="space-y-2">
          <p className="text-xs text-text-tertiary mb-4">
            All 5 policy types are shown. Disabled policies are placeholders — configure them via
            the API or SDK.
          </p>
          <div className="space-y-px bg-border">
            {policies.map((policy, i) => (
              <motion.div
                key={policy.id || i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05, duration: 0.3 }}
                className="bg-bg p-5 flex items-center justify-between"
              >
                <div className="flex items-center gap-4">
                  <span
                    className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      policy.enabled ? "bg-emerald-400" : "bg-text-tertiary/30"
                    }`}
                  />
                  <div>
                    <div
                      className={`text-sm font-display font-600 ${
                        policy.enabled ? "text-text" : "text-text-tertiary"
                      }`}
                    >
                      {policyTypeLabel(policy.type)}
                    </div>
                    <div className="text-xs text-text-tertiary mt-0.5">
                      {policy.enabled
                        ? formatPolicyConfig(policy.type, policy.config as Record<string, string>)
                        : "Not configured"}
                    </div>
                  </div>
                </div>
                <span
                  className={`text-xs flex-shrink-0 ${
                    policy.enabled ? "text-emerald-400" : "text-text-tertiary/50"
                  }`}
                >
                  {policy.enabled ? "Active" : "Disabled"}
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function formatPolicyConfig(type: string, config: Record<string, string>): string {
  switch (type) {
    case "spending-limit":
      return `Max ${formatWei(config.maxPerTx || "0")} ETH/tx · ${formatWei(
        config.maxPerDay || "0",
      )} ETH/day`;
    case "approved-addresses": {
      const addresses = config.addresses as unknown;
      const count = Array.isArray(addresses) ? addresses.length : 0;
      return `${count} address${count !== 1 ? "es" : ""} (${config.mode || "whitelist"})`;
    }
    case "auto-approve-threshold":
      return `Auto-approve below ${formatWei(config.threshold || "0")} ETH`;
    case "time-window": {
      const hours = config.allowedHours as unknown;
      const days = config.allowedDays as unknown;
      return `${Array.isArray(hours) ? hours.length : 0} hour windows · ${
        Array.isArray(days) ? days.length : 7
      } days/week`;
    }
    case "rate-limit":
      return `${config.maxTxPerHour || 0}/hour · ${config.maxTxPerDay || 0}/day`;
    case "allowed-chains": {
      const chainIds = config.chainIds as unknown;
      const count = Array.isArray(chainIds) ? chainIds.length : 0;
      return `${count} chain${count !== 1 ? "s" : ""} allowed`;
    }
    default:
      return JSON.stringify(config);
  }
}
