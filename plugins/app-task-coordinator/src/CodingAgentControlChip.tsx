import { client, useApp, usePtySessions } from "@elizaos/ui";
import { Button } from "@elizaos/ui";
import { Square, Terminal } from "lucide-react";
import { useCallback } from "react";

/**
 * Compact composer-area strip when Parallax coding agents have active PTY sessions:
 * session count plus one-click stop-all (same API as chat Stop for running agents).
 */
export function CodingAgentControlChip() {
  const { t } = useApp();
  const { ptySessions } = usePtySessions();

  const stopAll = useCallback(() => {
    for (const s of ptySessions) {
      void client.stopCodingAgent(s.sessionId);
    }
  }, [ptySessions]);

  if (ptySessions.length === 0) return null;

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
            count: String(ptySessions.length),
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
