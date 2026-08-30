/**
 * Drawer variant of PtyConsoleBase — wraps the PTY console with a session
 * switcher and a new-session control for the bottom-drawer surface.
 */

import { Button } from "@elizaos/ui";
import type { CodingAgentSession } from "@elizaos/ui/api/client-types-cloud";
import { Plus, Terminal } from "lucide-react";
import { PtyConsoleBase } from "./PtyConsoleBase";

export interface PtyConsoleDrawerProps {
  activeSessionId: string | null;
  sessions: CodingAgentSession[];
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  onClose: () => void;
}

export function PtyConsoleDrawer({
  activeSessionId,
  sessions,
  onSessionClick,
  onNewSession,
  onClose,
}: PtyConsoleDrawerProps) {
  const resolvedSessionId =
    activeSessionId &&
    sessions.some((session) => session.sessionId === activeSessionId)
      ? activeSessionId
      : (sessions[0]?.sessionId ?? null);

  return (
    <section
      className="flex h-[min(76vh,44rem)] w-full min-w-0 overflow-hidden rounded-t-lg border border-border/70 bg-bg"
      aria-label="Agent terminal drawer"
      data-testid="pty-console-drawer"
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-border/60 bg-muted/10">
        <header className="flex h-10 items-center gap-2 border-b border-border/60 px-3">
          <Terminal className="size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
            Terminals
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewSession}
            title="New terminal"
            aria-label="New terminal"
          >
            <Plus className="size-4" aria-hidden />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {sessions.length === 0 ? (
            <Button
              variant="outline"
              size="row"
              align="start"
              type="button"
              onClick={onNewSession}
            >
              Start terminal
            </Button>
          ) : (
            sessions.map((session) => {
              const selected = session.sessionId === resolvedSessionId;
              return (
                <Button
                  variant="selection"
                  size="eventRow"
                  align="start"
                  data-state={selected ? "on" : "off"}
                  key={session.sessionId}
                  type="button"
                  onClick={() => onSessionClick(session.sessionId)}
                  className="mb-1"
                >
                  <div className="truncate font-medium">
                    {session.label ?? "Terminal"}
                  </div>
                  <div className="truncate text-[11px] opacity-75">
                    {session.workdir ?? session.sessionId}
                  </div>
                </Button>
              );
            })
          )}
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        {resolvedSessionId ? (
          <PtyConsoleBase
            activeSessionId={resolvedSessionId}
            sessions={sessions}
            onClose={onClose}
            variant="full"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            None
          </div>
        )}
      </div>
    </section>
  );
}
