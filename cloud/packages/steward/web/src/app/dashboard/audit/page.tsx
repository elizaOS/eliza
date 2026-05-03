"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { steward } from "@/lib/api";
import type {
  AgentIdentity,
  AuditEntry,
  AuditQueryParams,
  AuditSummary,
} from "@/lib/steward-client";
import { formatDate } from "@/lib/utils";

const ease: [number, number, number, number] = [0.25, 1, 0.5, 1];

const ACTION_TYPES = [
  "all",
  "api_call",
  "sign_tx",
  "approve",
  "reject",
  "policy_check",
  "secret_inject",
  "rotate_secret",
  "create_agent",
];

function resultColor(result: AuditEntry["result"]) {
  const map: Record<AuditEntry["result"], string> = {
    allow: "text-emerald-400 bg-emerald-400/10",
    deny: "text-red-400 bg-red-400/10",
    error: "text-orange-400 bg-orange-400/10",
  };
  return map[result] || "text-text-tertiary bg-bg-surface";
}

function formatCost(cost?: string): string {
  if (!cost || cost === "0") return "--";
  const n = parseFloat(cost);
  if (Number.isNaN(n)) return cost;
  return n < 0.0001 ? "<$0.0001" : `$${n.toFixed(4)}`;
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [summary, setSummary] = useState<AuditSummary[]>([]);
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filters, setFilters] = useState<AuditQueryParams>({
    agentId: "",
    action: "",
    result: "",
    from: "",
    to: "",
    limit: 50,
    offset: 0,
  });
  const [applied, setApplied] = useState<AuditQueryParams>({});

  // Expanded detail
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadData = useCallback(async (params: AuditQueryParams) => {
    setLoading(true);
    setError(null);
    try {
      const clean: AuditQueryParams = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== "" && v !== undefined && v !== 0),
      ) as AuditQueryParams;
      if (!clean.limit) clean.limit = 50;

      const [log, sum, agentList] = await Promise.all([
        steward.getAuditLog(clean),
        steward.getAuditSummary(),
        steward.listAgents(),
      ]);
      setEntries(log);
      setSummary(sum);
      setAgents(agentList);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load audit log");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData({});
  }, [loadData]);

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    setApplied(filters);
    loadData(filters);
  }

  function clearFilters() {
    const empty: AuditQueryParams = {
      agentId: "",
      action: "",
      result: "",
      from: "",
      to: "",
      limit: 50,
      offset: 0,
    };
    setFilters(empty);
    setApplied({});
    loadData({});
  }

  const agentName = useCallback(
    (id?: string): string => {
      if (!id) return "System";
      const a = agents.find((ag) => ag.id === id);
      return a?.name || id;
    },
    [agents],
  );

  const summaryByAgent = useCallback(
    (agentId: string): AuditSummary | undefined => {
      return summary.find((s) => s.agentId === agentId);
    },
    [summary],
  );

  const totalCost = summary.reduce((acc, s) => acc + (parseFloat(s.totalCost) || 0), 0);
  const totalActions = summary.reduce((acc, s) => acc + s.totalActions, 0);
  const totalDenied = summary.reduce((acc, s) => acc + s.denyCount, 0);

  const activeFilters = Object.entries(applied).filter(
    ([k, v]) => v !== "" && v !== undefined && k !== "limit" && k !== "offset",
  ).length;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="space-y-8"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-700 tracking-tight">Audit Log</h1>
          <p className="text-sm text-text-tertiary mt-1">
            All agent actions, policy decisions, and system events
          </p>
        </div>
        <button
          onClick={() => loadData(applied)}
          className="px-4 py-2 text-sm border border-border text-text-tertiary hover:text-text hover:border-accent transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      {!loading && !error && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            {
              label: "Total Actions",
              value: totalActions.toLocaleString(),
              accent: false,
            },
            {
              label: "Denied",
              value: totalDenied.toLocaleString(),
              accent: totalDenied > 0,
            },
            {
              label: "Total Cost",
              value: formatCost(totalCost.toString()),
              accent: false,
            },
            {
              label: "Active Agents",
              value: summary.length.toString(),
              accent: false,
            },
          ].map(({ label, value, accent }) => (
            <div key={label} className="border border-border bg-bg-elevated p-4 space-y-1">
              <div className="text-xs text-text-tertiary">{label}</div>
              <div
                className={`font-display text-xl font-700 tabular-nums ${accent ? "text-red-400" : "text-text"}`}
              >
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-agent summary */}
      {!loading && !error && summary.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs text-text-tertiary uppercase tracking-wider">Spend by Agent</h3>
          <div className="border-t border-border-subtle">
            {summary.map((s) => (
              <div
                key={s.agentId}
                className="flex items-center justify-between py-3 border-b border-border-subtle"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 flex items-center justify-center bg-accent-bg font-display font-700 text-xs text-[oklch(0.75_0.15_55)] flex-shrink-0">
                    {(s.agentName || s.agentId).charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-display font-600 truncate">
                      {s.agentName || s.agentId}
                    </div>
                    <div className="text-xs text-text-tertiary font-mono truncate">{s.agentId}</div>
                  </div>
                </div>
                <div className="flex items-center gap-6 flex-shrink-0 text-xs tabular-nums">
                  <div className="text-right hidden md:block">
                    <div className="text-text-secondary">{s.totalActions.toLocaleString()}</div>
                    <div className="text-text-tertiary">actions</div>
                  </div>
                  <div className="text-right hidden md:block">
                    <div className="text-emerald-400">{s.allowCount.toLocaleString()}</div>
                    <div className="text-text-tertiary">allowed</div>
                  </div>
                  <div className="text-right hidden md:block">
                    <div className={s.denyCount > 0 ? "text-red-400" : "text-text-tertiary"}>
                      {s.denyCount.toLocaleString()}
                    </div>
                    <div className="text-text-tertiary">denied</div>
                  </div>
                  <div className="text-right">
                    <div className="text-text-secondary">{formatCost(s.totalCost)}</div>
                    <div className="text-text-tertiary">cost</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <form onSubmit={applyFilters} className="border border-border bg-bg-elevated p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-text-tertiary block mb-1">Agent</label>
            <select
              value={filters.agentId}
              onChange={(e) => setFilters({ ...filters, agentId: e.target.value })}
              className="w-full bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-accent transition-colors"
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-text-tertiary block mb-1">Action Type</label>
            <select
              value={filters.action}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  action: e.target.value === "all" ? "" : e.target.value,
                })
              }
              className="w-full bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-accent transition-colors"
            >
              {ACTION_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a === "all" ? "All actions" : a.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 min-w-[120px]">
            <label className="text-xs text-text-tertiary block mb-1">Result</label>
            <select
              value={filters.result}
              onChange={(e) => setFilters({ ...filters, result: e.target.value })}
              className="w-full bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-accent transition-colors"
            >
              <option value="">All results</option>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
              <option value="error">Error</option>
            </select>
          </div>

          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-text-tertiary block mb-1">From</label>
            <input
              type="datetime-local"
              value={filters.from}
              onChange={(e) => setFilters({ ...filters, from: e.target.value })}
              className="w-full bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex-1 min-w-[140px]">
            <label className="text-xs text-text-tertiary block mb-1">To</label>
            <input
              type="datetime-local"
              value={filters.to}
              onChange={(e) => setFilters({ ...filters, to: e.target.value })}
              className="w-full bg-bg border border-border px-3 py-2 text-sm text-text focus:outline-none focus:border-accent transition-colors"
            />
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors font-medium whitespace-nowrap"
            >
              Apply
              {activeFilters > 0 && (
                <span className="ml-1.5 text-xs bg-bg/30 px-1 py-0.5">{activeFilters}</span>
              )}
            </button>
            {activeFilters > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className="px-3 py-2 text-sm text-text-tertiary hover:text-text border border-border transition-colors whitespace-nowrap"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </form>

      {/* Error */}
      {error && !loading && (
        <div className="py-16 text-center border border-red-400/20 bg-red-400/5">
          <p className="text-text-secondary text-sm mb-1">Failed to load audit log</p>
          <p className="text-text-tertiary text-xs mb-4 font-mono">{error}</p>
          <button
            onClick={() => loadData(applied)}
            className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Log table */}
      {loading ? (
        <div className="space-y-px bg-border">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-bg h-14 animate-pulse" />
          ))}
        </div>
      ) : !error && entries.length === 0 ? (
        <div className="py-20 text-center border border-border-subtle">
          <p className="font-display text-lg font-600 text-text-secondary">No events found</p>
          <p className="text-sm text-text-tertiary mt-2 max-w-sm mx-auto">
            {activeFilters > 0
              ? "No events match the current filters. Try adjusting your criteria."
              : "Audit events will appear here as agents take actions."}
          </p>
          {activeFilters > 0 && (
            <button
              onClick={clearFilters}
              className="mt-4 px-4 py-2 text-sm border border-border text-text-tertiary hover:text-text transition-colors"
            >
              Clear Filters
            </button>
          )}
        </div>
      ) : !error ? (
        <div className="overflow-x-auto">
          {/* Column headers */}
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-3 py-2 text-xs text-text-tertiary uppercase tracking-wider border-b border-border-subtle min-w-[600px]">
            <span>Action</span>
            <span className="hidden md:block">Agent</span>
            <span className="hidden md:block">Result</span>
            <span className="hidden md:block">Cost</span>
            <span>Time</span>
          </div>

          <AnimatePresence initial={false}>
            {entries.map((entry, i) => (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ delay: i * 0.02, duration: 0.2, ease }}
              >
                <button
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  className="w-full text-left"
                >
                  <div
                    className={`grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-3 py-3.5 border-b border-border-subtle transition-colors items-center ${
                      expanded === entry.id ? "bg-bg-elevated" : "hover:bg-bg-elevated/30"
                    }`}
                  >
                    <div className="min-w-0">
                      <span className="text-sm font-mono text-text-secondary truncate block">
                        {entry.action}
                      </span>
                    </div>
                    <div className="hidden md:block text-sm text-text-secondary whitespace-nowrap">
                      {agentName(entry.agentId)}
                    </div>
                    <div className="hidden md:block">
                      <span
                        className={`text-xs px-1.5 py-0.5 font-medium ${resultColor(entry.result)}`}
                      >
                        {entry.result}
                      </span>
                    </div>
                    <div className="hidden md:block text-xs font-mono text-text-tertiary tabular-nums whitespace-nowrap">
                      {formatCost(entry.cost)}
                    </div>
                    <div className="text-xs text-text-tertiary whitespace-nowrap tabular-nums">
                      {formatDate(entry.timestamp)}
                    </div>
                  </div>
                </button>

                {/* Expanded detail */}
                <AnimatePresence>
                  {expanded === entry.id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease }}
                      className="overflow-hidden"
                    >
                      <div className="px-3 py-4 bg-bg-elevated border-b border-border-subtle space-y-3">
                        {/* Mobile fields */}
                        <div className="flex flex-wrap gap-4 md:hidden text-xs">
                          <div className="space-y-0.5">
                            <div className="text-text-tertiary">Agent</div>
                            <div className="text-text-secondary">{agentName(entry.agentId)}</div>
                          </div>
                          <div className="space-y-0.5">
                            <div className="text-text-tertiary">Result</div>
                            <span
                              className={`px-1.5 py-0.5 font-medium ${resultColor(entry.result)}`}
                            >
                              {entry.result}
                            </span>
                          </div>
                          <div className="space-y-0.5">
                            <div className="text-text-tertiary">Cost</div>
                            <div className="font-mono text-text-secondary">
                              {formatCost(entry.cost)}
                            </div>
                          </div>
                        </div>

                        {/* Details JSON */}
                        {entry.details && Object.keys(entry.details).length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs text-text-tertiary">Details</div>
                            <pre className="text-xs font-mono text-text-secondary bg-bg p-3 border border-border-subtle overflow-x-auto">
                              {JSON.stringify(entry.details, null, 2)}
                            </pre>
                          </div>
                        )}

                        {/* Entry ID */}
                        <div className="text-xs text-text-tertiary font-mono">ID: {entry.id}</div>

                        {/* Agent summary inline */}
                        {(() => {
                          if (!entry.agentId) return null;
                          const agentSummary = summaryByAgent(entry.agentId);
                          if (!agentSummary) return null;

                          return (
                            <div className="flex items-center gap-4 text-xs text-text-tertiary border-t border-border-subtle pt-3">
                              <span>Agent totals:</span>
                              <span>{agentSummary.totalActions} actions</span>
                              <span className="text-emerald-400">
                                {agentSummary.allowCount} allowed
                              </span>
                              {agentSummary.denyCount > 0 && (
                                <span className="text-red-400">
                                  {agentSummary.denyCount} denied
                                </span>
                              )}
                              <span>{formatCost(agentSummary.totalCost)} total cost</span>
                            </div>
                          );
                        })()}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Load more */}
          {entries.length >= (filters.limit || 50) && (
            <div className="pt-4 flex justify-center">
              <button
                onClick={() => {
                  const next = {
                    ...applied,
                    offset: (applied.offset || 0) + (applied.limit || 50),
                  };
                  setApplied(next);
                  loadData(next);
                }}
                className="px-6 py-2 text-sm border border-border text-text-tertiary hover:text-text hover:border-accent transition-colors"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      ) : null}
    </motion.div>
  );
}
