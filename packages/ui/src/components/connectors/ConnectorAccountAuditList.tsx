import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import type { ConnectorAccountAuditEventRecord } from "../../api/client-agent";
import { cn } from "../../lib/utils";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";

type TranslateFn = TranslationContextValue["t"];

export interface ConnectorAccountAuditListProps {
  provider: string;
  accountId?: string;
  limit?: number;
  className?: string;
}

function formatAuditTime(value: number | undefined, t: TranslateFn): string {
  const unknown = t("connectoraudit.unknownTime", {
    defaultValue: "Unknown time",
  });
  if (!value) return unknown;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? unknown : date.toLocaleString();
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
  const { t } = useTranslation();
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
          : t("connectoraudit.loadError", {
              defaultValue: "Failed to load audit events",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [provider, query, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div
      className={cn(
        "rounded-sm border border-border/45 bg-card/35 text-sm",
        className,
      )}
    >
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/35 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase text-muted">
            {t("connectoraudit.title", { defaultValue: "Audit trail" })}
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
          aria-label={t("connectoraudit.refreshAria", {
            defaultValue: "Refresh connector audit events",
          })}
          title={t("connectoraudit.refreshAria", {
            defaultValue: "Refresh connector audit events",
          })}
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
          {t("connectoraudit.empty", { defaultValue: "No audit events." })}
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
                  {formatAuditTime(event.createdAt, t)}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                {event.actorId ? (
                  <span>
                    {t("connectoraudit.actor", {
                      actor: event.actorId,
                      defaultValue: "Actor {{actor}}",
                    })}
                  </span>
                ) : null}
                {event.accountId ? (
                  <span>
                    {t("connectoraudit.account", {
                      account: event.accountId,
                      defaultValue: "Account {{account}}",
                    })}
                  </span>
                ) : null}
              </div>
              <pre className="max-h-24 overflow-auto rounded-sm border border-border/30 bg-bg/35 p-2 text-[11px] leading-relaxed text-muted">
                {metadataPreview(event.metadata)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
