"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

interface PolicyRule {
  id?: string;
  type: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  description?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatConfigValue(val: unknown): string {
  if (val == null) return "—";
  if (typeof val === "boolean") return val ? "yes" : "no";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function policyLabel(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Main Component ───────────────────────────────────────────────────────────

interface ElizaPoliciesSectionProps {
  agentId: string;
}

export function ElizaPoliciesSection({ agentId }: ElizaPoliciesSectionProps) {
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const base = `/api/v1/eliza/agents/${agentId}/api/wallet`;

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${base}/steward-policies`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      if (!mountedRef.current) return;
      setPolicies(Array.isArray(data) ? data : (data.policies ?? []));
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : "Failed to load policies";
      setError(
        msg.includes("503") || msg.includes("not configured")
          ? "Steward is not configured for this agent. Policies require a connected Steward instance."
          : msg,
      );
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    mountedRef.current = true;
    fetchPolicies();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchPolicies]);

  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 bg-white/5 border border-white/10" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-3 p-4 bg-amber-950/20 border border-amber-500/20">
        <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0 mt-1" />
        <div>
          <p className="font-mono text-xs text-amber-400">{error}</p>
          <button
            type="button"
            onClick={fetchPolicies}
            className="font-mono text-[11px] text-[#FF5800] hover:text-[#FF5800]/70 transition-colors mt-2"
          >
            RETRY
          </button>
        </div>
      </div>
    );
  }

  if (policies.length === 0) {
    return (
      <div className="p-8 text-center border border-white/10 bg-black/40">
        <p className="font-mono text-sm text-white/40">No policies yet</p>
        <p className="font-mono text-xs text-white/20 mt-1">
          Policies will appear here once configured through the Steward dashboard.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {policies.map((policy, i) => {
        const configEntries = policy.config ? Object.entries(policy.config) : [];
        return (
          <div key={policy.id ?? `policy-${i}`} className="border border-white/10 bg-black/40">
            {/* Policy header */}
            <div className="px-4 py-3 flex items-center justify-between border-b border-white/5">
              <div className="flex items-center gap-3">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    policy.enabled ? "bg-emerald-500" : "bg-white/20"
                  }`}
                />
                <span
                  className="font-mono text-sm text-white/80"
                  style={{ fontFamily: "var(--font-roboto-mono)" }}
                >
                  {policyLabel(policy.type)}
                </span>
              </div>
              <span
                className={`font-mono text-[10px] tracking-wide px-2 py-0.5 border ${
                  policy.enabled
                    ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                    : "text-white/30 border-white/10"
                }`}
              >
                {policy.enabled ? "ENABLED" : "DISABLED"}
              </span>
            </div>

            {/* Policy description */}
            {policy.description && (
              <div className="px-4 py-2 border-b border-white/5">
                <p className="font-mono text-xs text-white/40">{policy.description}</p>
              </div>
            )}

            {/* Config values */}
            {configEntries.length > 0 && (
              <div className="divide-y divide-white/5">
                {configEntries.map(([key, val]) => (
                  <div
                    key={key}
                    className="px-4 py-2.5 grid grid-cols-[180px_1fr] gap-4 items-start"
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-white/30 break-all">
                      {key.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono text-xs text-white/70 break-all">
                      {formatConfigValue(val)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
