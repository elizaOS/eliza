"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { steward } from "@/lib/api";
import type { AgentIdentity } from "@/lib/steward-client";
import { formatDate, shortenAddress } from "@/lib/utils";

const easeOutQuart: [number, number, number, number] = [0.25, 1, 0.5, 1];

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [form, setForm] = useState({ id: "", name: "", platformId: "" });

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  async function loadAgents() {
    try {
      setLoading(true);
      setError(null);
      const list = await steward.listAgents();
      setAgents(list);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!form.id || !form.name) return;
    setCreateError(null);
    try {
      setCreating(true);
      const newAgent = await steward.createWallet(form.id, form.name, form.platformId || undefined);
      // Add directly to list without re-fetching
      setAgents((prev) => [newAgent, ...prev]);
      setShowCreate(false);
      setForm({ id: "", name: "", platformId: "" });
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setCreating(false);
    }
  }

  function handleCancelCreate() {
    setShowCreate(false);
    setCreateError(null);
    setForm({ id: "", name: "", platformId: "" });
  }

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
          <h1 className="font-display text-2xl font-700 tracking-tight">Agents</h1>
          <p className="text-sm text-text-tertiary mt-1">Manage agent wallets and policies</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors font-medium"
        >
          New Agent
        </button>
      </div>

      {/* Create form — inline, not a modal */}
      <AnimatePresence>
        {showCreate && (
          <motion.form
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: easeOutQuart }}
            onSubmit={createAgent}
            className="overflow-hidden"
          >
            <div className="border border-border bg-bg-elevated p-6 space-y-5">
              <h3 className="font-display text-sm font-600">Create Agent</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-xs text-text-tertiary block mb-1.5">
                    Agent ID <span className="text-accent">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.id}
                    onChange={(e) => setForm({ ...form, id: e.target.value })}
                    placeholder="my-trading-agent"
                    className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-tertiary block mb-1.5">
                    Display Name <span className="text-accent">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Trading Agent #1"
                    className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-tertiary block mb-1.5">
                    Platform ID <span className="text-text-tertiary">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={form.platformId}
                    onChange={(e) => setForm({ ...form, platformId: e.target.value })}
                    placeholder="discord / twitter / etc."
                    className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
              </div>

              {/* Error */}
              <AnimatePresence>
                {createError && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="text-xs text-red-400 font-mono"
                  >
                    {createError}
                  </motion.p>
                )}
              </AnimatePresence>

              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={creating || !form.id || !form.name}
                  className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  {creating ? "Creating..." : "Create"}
                </button>
                <button
                  type="button"
                  onClick={handleCancelCreate}
                  className="px-4 py-2 text-sm text-text-tertiary hover:text-text transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Error state */}
      {error && !loading && (
        <div className="py-16 text-center border border-red-400/20 bg-red-400/5">
          <p className="text-text-secondary text-sm mb-1">Failed to load agents</p>
          <p className="text-text-tertiary text-xs mb-4 font-mono">{error}</p>
          <button
            onClick={loadAgents}
            className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Agent list */}
      {loading ? (
        <div className="space-y-px bg-border">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-bg h-20 animate-pulse" />
          ))}
        </div>
      ) : error ? null : agents.length === 0 ? (
        <div className="py-20 text-center border border-border-subtle">
          <p className="font-display text-lg font-600 text-text-secondary">No agents yet</p>
          <p className="text-sm text-text-tertiary mt-2 max-w-sm mx-auto">
            Create your first agent to generate a managed wallet with policy enforcement. Each agent
            gets its own address on Base.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-6 px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Create First Agent
          </button>
        </div>
      ) : (
        <div className="border-t border-border-subtle">
          <AnimatePresence initial={false}>
            {agents.map((agent, i) => (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ delay: i * 0.04, duration: 0.3 }}
              >
                <Link
                  href={`/dashboard/agents/${agent.id}`}
                  className="flex items-center justify-between py-5 border-b border-border-subtle hover:bg-bg-elevated/30 transition-colors px-2 -mx-2 group"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-9 h-9 flex items-center justify-center bg-accent-bg font-display font-700 text-sm text-[oklch(0.75_0.15_55)] flex-shrink-0">
                      {agent.name?.charAt(0)?.toUpperCase() || "A"}
                    </div>
                    <div className="min-w-0">
                      <div className="font-display font-600 text-sm group-hover:text-accent transition-colors truncate">
                        {agent.name}
                      </div>
                      <div className="text-xs text-text-tertiary mt-0.5 truncate">
                        {agent.id}
                        {agent.platformId && (
                          <span className="ml-2 text-text-tertiary/60">· {agent.platformId}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 flex-shrink-0">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-xs text-text-tertiary">
                        {shortenAddress(agent.walletAddress, 6)}
                      </span>
                      <CopyButton text={agent.walletAddress} />
                    </div>
                    <span className="text-xs text-text-tertiary hidden md:inline">
                      {agent.createdAt ? formatDate(agent.createdAt) : ""}
                    </span>
                  </div>
                </Link>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
