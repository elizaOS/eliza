import { Button, client, useApp } from "@elizaos/ui";
import type { CodingAgentSession } from "@elizaos/ui/api/client-types-cloud";
import { Square, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const TERMINAL_STATUSES = new Set(["completed", "stopped", "error", "errored"]);

export function CodingAgentControlChip() {
  const { t } = useApp();
  const [sessions, setSessions] = useState<CodingAgentSession[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const status = await client.getCodingAgentStatus();
      if (cancelled) return;
      setSessions(
        (status?.tasks ?? []).filter(
          (session) => !TERMINAL_STATUSES.has(session.status),
        ),
      );
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const stopAll = useCallback(() => {
    for (const s of sessions) {
      void client.stopCodingAgent(s.sessionId);
    }
  }, [sessions]);

  if (sessions.length === 0) return null;

  return (
    <div className="mb-2 flex items-center justify-between gap-2 rounded-2xl border border-border/28 bg-card/50 px-3 py-1.5 ring-1 ring-inset ring-white/6">
      <div className="flex min-w-0 items-center gap-1.5 text-xs-tight text-muted">
        <Terminal
          className="h-3.5 w-3.5 shrink-0 text-muted-strong"
          aria-hidden
        />
        <span className="truncate">
          {t("codingagentcontrolchip.ActiveSessions", {
            defaultValue: "{{count}} active coding session(s)",
            count: String(sessions.length),
          })}
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 px-2.5 text-xs-tight"
        onClick={stopAll}
        title={t("codingagentcontrolchip.StopAllTitle", {
          defaultValue: "Stop all coding agent sessions",
        })}
      >
        <Square className="h-3 w-3 fill-current" aria-hidden />
        {t("codingagentcontrolchip.StopAll", { defaultValue: "Stop all" })}
      </Button>
    </div>
  );
}
