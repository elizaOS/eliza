import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  client,
  type SecurityAuditEntry,
  type SecurityAuditSeverity,
} from "../api";
import { formatDateTime } from "./format";

const SEVERITY_OPTIONS: Array<{
  value: "" | SecurityAuditSeverity;
  label: string;
}> = [
  { value: "", label: "All severities" },
  { value: "critical", label: "Critical" },
  { value: "error", label: "Error" },
  { value: "warn", label: "Warn" },
  { value: "info", label: "Info" },
];

const SEVERITY_STYLES: Record<
  SecurityAuditSeverity,
  { badge: string; tone: string }
> = {
  critical: {
    badge: "bg-red-500/15 text-red-300 border-red-500/30",
    tone: "text-red-200",
  },
  error: {
    badge: "bg-orange-500/15 text-orange-200 border-orange-500/30",
    tone: "text-orange-100",
  },
  warn: {
    badge: "bg-amber-500/15 text-amber-200 border-amber-500/30",
    tone: "text-amber-100",
  },
  info: {
    badge: "bg-sky-500/15 text-sky-200 border-sky-500/30",
    tone: "text-sky-100",
  },
};

function summarizeCounts(entries: SecurityAuditEntry[]) {
  return entries.reduce<Record<SecurityAuditSeverity, number>>(
    (counts, entry) => {
      counts[entry.severity] += 1;
      return counts;
    },
    {
      critical: 0,
      error: 0,
      warn: 0,
      info: 0,
    },
  );
}

function metadataPairs(entry: SecurityAuditEntry): Array<[string, string]> {
  return Object.entries(entry.metadata ?? {}).map(([key, value]) => [
    key,
    String(value),
  ]);
}

export function SecurityPageView() {
  const [entries, setEntries] = useState<SecurityAuditEntry[]>([]);
  const [totalBuffered, setTotalBuffered] = useState(0);
  const [severity, setSeverity] = useState<"" | SecurityAuditSeverity>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await client.getSecurityAudit({
        limit: 50,
        severity: severity || undefined,
      });
      setEntries(response.entries);
      setTotalBuffered(response.totalBuffered);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log.");
    } finally {
      setLoading(false);
    }
  }, [severity]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const counts = useMemo(() => summarizeCounts(entries), [entries]);

  return (
    <section data-testid="security-audit-view" className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-bold">Security Audit</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Review privileged actions, policy decisions, and runtime security
            events.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Security severity filter"
            className="h-9 min-w-40 rounded-xl border border-border bg-bg px-3 text-sm text-txt"
            value={severity}
            onChange={(event) =>
              setSeverity(event.target.value as "" | SecurityAuditSeverity)
            }
          >
            {SEVERITY_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 rounded-xl"
            onClick={() => void loadAudit()}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border border-border/60 bg-card/50 p-4">
          <div className="text-xs uppercase tracking-[0.16em] text-muted">
            Buffered
          </div>
          <div className="mt-2 text-2xl font-semibold">{totalBuffered}</div>
        </div>
        {(["critical", "error", "warn", "info"] as const).map((level) => (
          <div
            key={level}
            className="rounded-2xl border border-border/60 bg-card/50 p-4"
          >
            <div className="text-xs uppercase tracking-[0.16em] text-muted">
              {level}
            </div>
            <div
              className={`mt-2 text-2xl font-semibold ${SEVERITY_STYLES[level].tone}`}
            >
              {counts[level]}
            </div>
          </div>
        ))}
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border/60 bg-card/35">
        {loading && entries.length === 0 ? (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">
            Loading security audit...
          </div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">
            No security events recorded for the current filter.
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {entries.map((entry, index) => {
              const metadata = metadataPairs(entry);
              const severityStyle = SEVERITY_STYLES[entry.severity];
              return (
                <article
                  key={`${entry.timestamp}-${entry.type}-${index}`}
                  className="px-4 py-4"
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] ${severityStyle.badge}`}
                        >
                          {entry.severity}
                        </span>
                        <span className="text-xs text-[var(--muted)]">
                          {entry.type}
                        </span>
                      </div>
                      <div className="mt-2 text-sm font-medium text-txt">
                        {entry.summary}
                      </div>
                    </div>
                    <div className="text-right text-xs text-[var(--muted)]">
                      {formatDateTime(entry.timestamp)}
                    </div>
                  </div>

                  {entry.traceId ? (
                    <div className="mt-2 text-xs text-[var(--muted)]">
                      Trace:{" "}
                      <span className="font-mono text-txt">{entry.traceId}</span>
                    </div>
                  ) : null}

                  {metadata.length > 0 ? (
                    <dl className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {metadata.map(([key, value]) => (
                        <div
                          key={`${entry.timestamp}-${key}`}
                          className="rounded-xl border border-border/40 bg-bg/40 px-3 py-2"
                        >
                          <dt className="text-[11px] uppercase tracking-[0.12em] text-muted">
                            {key}
                          </dt>
                          <dd className="mt-1 break-all font-mono text-xs text-txt">
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
