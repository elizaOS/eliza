"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { steward } from "@/lib/api";
import { formatDate } from "@/lib/utils";

interface TenantInfo {
  tenantId: string;
  tenantName: string;
  role: string;
  joinedAt: string;
}

interface CreatedTenant {
  tenantId: string;
  apiKey: string;
}

const easeOutQuart: [number, number, number, number] = [0.25, 1, 0.5, 1];

export default function TenantsPage() {
  const [tenants, setTenants] = useState<TenantInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedTenant | null>(null);
  const [activeTenantId, setActiveTenantId] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "" });

  useEffect(() => {
    loadTenants();
    // Read active tenant from localStorage if available
    try {
      const stored = localStorage.getItem("steward_active_tenant");
      if (stored) setActiveTenantId(stored);
    } catch {}
  }, [loadTenants]);

  async function loadTenants() {
    try {
      setLoading(true);
      setError(null);
      const list = await steward.listTenants();
      setTenants(list);
      // If no active tenant set but we have tenants, use first one
      if (!activeTenantId && list.length > 0) {
        setActiveTenantId(list[0].tenantId);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load tenants");
    } finally {
      setLoading(false);
    }
  }

  async function switchTenant(tenantId: string) {
    try {
      setSwitching(tenantId);
      await steward.switchTenant(tenantId);
      setActiveTenantId(tenantId);
      localStorage.setItem("steward_active_tenant", tenantId);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to switch tenant");
    } finally {
      setSwitching(null);
    }
  }

  async function createTenant(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name) return;
    setCreateError(null);
    try {
      setCreating(true);
      const result = await steward.createTenant(form.name, form.description || undefined);
      setCreated(result);
      // Add to list
      setTenants((prev) => [
        ...prev,
        {
          tenantId: result.tenantId,
          tenantName: form.name,
          role: "owner",
          joinedAt: new Date().toISOString(),
        },
      ]);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create tenant");
    } finally {
      setCreating(false);
    }
  }

  function handleCancelCreate() {
    setShowCreate(false);
    setCreateError(null);
    setCreated(null);
    setForm({ name: "", description: "" });
  }

  function roleColor(role: string): string {
    switch (role) {
      case "owner":
        return "text-amber-400 bg-amber-400/10";
      case "admin":
        return "text-blue-400 bg-blue-400/10";
      case "member":
        return "text-emerald-400 bg-emerald-400/10";
      default:
        return "text-text-tertiary bg-bg-elevated";
    }
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
          <h1 className="font-display text-2xl font-700 tracking-tight">Tenants</h1>
          <p className="text-sm text-text-tertiary mt-1">
            Manage your organizations and switch between them
          </p>
        </div>
        <button
          onClick={() => {
            setShowCreate(!showCreate);
            setCreated(null);
          }}
          className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors font-medium"
        >
          Create Tenant
        </button>
      </div>

      {/* Create form */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: easeOutQuart }}
            className="overflow-hidden"
          >
            {created ? (
              /* Success state: show credentials */
              <div className="border border-border bg-bg-elevated p-6 space-y-5">
                <h3 className="font-display text-sm font-600 text-emerald-400">Tenant Created</h3>
                <p className="text-xs text-text-tertiary">
                  Save these credentials now. The API key won&apos;t be shown again.
                </p>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-text-tertiary block mb-1">Tenant ID</label>
                    <div className="flex items-center gap-2 bg-bg border border-border px-3 py-2">
                      <span className="font-mono text-sm text-text flex-1 truncate">
                        {created.tenantId}
                      </span>
                      <CopyButton text={created.tenantId} />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-text-tertiary block mb-1">API Key</label>
                    <div className="flex items-center gap-2 bg-bg border border-border px-3 py-2">
                      <span className="font-mono text-sm text-text flex-1 truncate">
                        {created.apiKey}
                      </span>
                      <CopyButton text={created.apiKey} />
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelCreate}
                  className="px-4 py-2 text-sm text-text-tertiary hover:text-text transition-colors"
                >
                  Done
                </button>
              </div>
            ) : (
              /* Create form */
              <form onSubmit={createTenant}>
                <div className="border border-border bg-bg-elevated p-6 space-y-5">
                  <h3 className="font-display text-sm font-600">Create Tenant</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-text-tertiary block mb-1.5">
                        Name <span className="text-accent">*</span>
                      </label>
                      <input
                        type="text"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="My Organization"
                        className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-text-tertiary block mb-1.5">
                        Description <span className="text-text-tertiary">(optional)</span>
                      </label>
                      <input
                        type="text"
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        placeholder="Production trading org"
                        className="w-full bg-bg border border-border px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
                      />
                    </div>
                  </div>

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
                      disabled={creating || !form.name}
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
              </form>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error state */}
      {error && !loading && (
        <div className="py-16 text-center border border-red-400/20 bg-red-400/5">
          <p className="text-text-secondary text-sm mb-1">Failed to load tenants</p>
          <p className="text-text-tertiary text-xs mb-4 font-mono">{error}</p>
          <button
            onClick={loadTenants}
            className="px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Tenant list */}
      {loading ? (
        <div className="space-y-px bg-border">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="bg-bg h-24 animate-pulse" />
          ))}
        </div>
      ) : error ? null : tenants.length === 0 ? (
        <div className="py-20 text-center border border-border-subtle">
          <p className="font-display text-lg font-600 text-text-secondary">No tenants yet</p>
          <p className="text-sm text-text-tertiary mt-2 max-w-sm mx-auto">
            Create your first tenant to start managing agents, policies, and secrets within an
            isolated organization.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-6 px-4 py-2 text-sm bg-accent text-bg hover:bg-accent-hover transition-colors"
          >
            Create First Tenant
          </button>
        </div>
      ) : (
        <div className="border-t border-border-subtle">
          <AnimatePresence initial={false}>
            {tenants.map((tenant, i) => {
              const isActive = tenant.tenantId === activeTenantId;
              return (
                <motion.div
                  key={tenant.tenantId}
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.3 }}
                >
                  <div
                    className={`flex items-center justify-between py-5 border-b border-border-subtle px-2 -mx-2 transition-colors ${
                      isActive
                        ? "bg-accent-bg/30 border-l-2 border-l-accent pl-4"
                        : "hover:bg-bg-elevated/30"
                    }`}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      <div
                        className={`w-9 h-9 flex items-center justify-center font-display font-700 text-sm flex-shrink-0 ${
                          isActive ? "bg-accent text-bg" : "bg-accent-bg text-[oklch(0.75_0.15_55)]"
                        }`}
                      >
                        {tenant.tenantName?.charAt(0)?.toUpperCase() || "T"}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-display font-600 text-sm truncate">
                            {tenant.tenantName}
                          </span>
                          {isActive && (
                            <span className="text-[10px] uppercase tracking-wider text-accent font-600">
                              Active
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="font-mono text-xs text-text-tertiary truncate">
                            {tenant.tenantId}
                          </span>
                          <CopyButton text={tenant.tenantId} />
                          <span
                            className={`text-[10px] px-1.5 py-0.5 font-600 uppercase tracking-wider ${roleColor(tenant.role)}`}
                          >
                            {tenant.role}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <span className="text-xs text-text-tertiary hidden md:inline">
                        {tenant.joinedAt ? formatDate(tenant.joinedAt) : ""}
                      </span>
                      {!isActive && (
                        <button
                          onClick={() => switchTenant(tenant.tenantId)}
                          disabled={switching === tenant.tenantId}
                          className="px-3 py-1.5 text-xs border border-border text-text-secondary hover:text-text hover:border-accent transition-colors disabled:opacity-40"
                        >
                          {switching === tenant.tenantId ? "Switching..." : "Switch"}
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}
