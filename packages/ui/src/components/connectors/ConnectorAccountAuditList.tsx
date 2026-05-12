import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import type { ConnectorAccountAuditEventRecord } from "../../api/client-agent";

export interface ConnectorAccountAuditListProps {
  provider: string;
  accountId?: string;
  limit?: number;
  className?: string;
}

function formatAuditTime(value: number | undefined): string {
  if (!value) return "Unknown time";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function metadataPreview(
  metadata: Record<string, unknown> | undefined,
): string {
  if (!metadata || Object.keys(metadata).length === 0) return "{}";
  return JSON.stringify(metadata);
}

function outcomeTone(
  outcome: string,
): "success" | "warning" | "danger" | "muted" {
  if (outcome === "success") return "success";
  if (outcome === "failure") return "danger";
  return "muted";
}

export function ConnectorAccountAuditList({
  provider,
  accountId,
  limit = 25,
  className,
}: ConnectorAccountAuditListProps) {
  const [events, setEvents] = useState<ConnectorAccountAuditEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      ...(accountId ? { accountId } : {}),
      limit,
    }),
    [accountId, limit],
  );

  const refresh = useCallback(async () => {
    if (!provider.trim()) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await client.listConnectorAccountAuditEvents(
        provider,
        query,
      );
      setEvents(response.events);
      setError(null);
    } catch (err) {
      setEvents([]);
      setError(
        err instanceof Error && err.message.trim()
          ? err.message
          : "Failed to load audit events",
      );
    } finally {
      setLoading(false);
    }
  }, [provider, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      className={cn(
        "rounded-lg border border-border/45 bg-card/35 text-sm",
        className,
      )}
    >
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/35 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-muted">
            Audit trail
          </div>
          <div className="truncate text-xs text-muted">
            {provider}
            {accountId ? ` / ${accountId}` : ""}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => void refresh()}
          aria-label="Refresh connector audit events"
          title="Refresh connector audit events"
          className="h-8 w-8 p-0"
        >
          {loading ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}
        </Button>
      </div>

      {error ? (
        <div className="px-3 py-2 text-xs text-danger">{error}</div>
      ) : null}

      {!loading && !error && events.length === 0 ? (
        <div className="px-3 py-6 text-center text-xs text-muted">
          No audit events.
        </div>
      ) : null}

      {events.length > 0 ? (
        <div className="max-h-80 divide-y divide-border/20 overflow-auto">
          {events.map((event) => (
            <div key={event.id} className="grid gap-2 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge
                  label={event.outcome}
                  tone={outcomeTone(event.outcome)}
                  withDot
                />
                <span className="font-medium text-txt">{event.action}</span>
                <span className="ml-auto text-xs text-muted">
                  {formatAuditTime(event.createdAt)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {event.actorId ? <span>Actor {event.actorId}</span> : null}
                {event.accountId ? (
                  <span>Account {event.accountId}</span>
                ) : null}
              </div>
              <pre className="max-h-24 overflow-auto rounded-md border border-border/30 bg-bg/35 p-2 text-[11px] leading-relaxed text-muted">
                {metadataPreview(event.metadata)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
