import { Button, type CodingAgentSession } from "@elizaos/ui";
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
      className="flex h-[min(76vh,44rem)] w-full min-w-0 overflow-hidden rounded-t-lg border border-border/70 bg-bg shadow-xl"
      aria-label="Agent terminal drawer"
      data-testid="pty-console-drawer"
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-border/60 bg-muted/10">
        <header className="flex h-10 items-center gap-2 border-b border-border/60 px-3">
          <Terminal className="h-4 w-4 shrink-0 text-muted" aria-hidden />
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
            <Plus className="h-4 w-4" aria-hidden />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {sessions.length === 0 ? (
            <button
              type="button"
              onClick={onNewSession}
              className="w-full rounded-md border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted hover:border-accent hover:text-txt"
            >
              Start terminal
            </button>
          ) : (
            sessions.map((session) => {
              const selected = session.sessionId === resolvedSessionId;
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  onClick={() => onSessionClick(session.sessionId)}
                  className={`mb-1 w-full rounded-md px-2 py-2 text-left text-xs transition ${
                    selected
                      ? "bg-accent/15 text-txt"
                      : "text-muted hover:bg-muted/20 hover:text-txt"
                  }`}
                >
                  <div className="truncate font-medium">
                    {session.label}
                  </div>
                  <div className="truncate text-[11px] opacity-75">
                    {session.workdir}
                  </div>
                </button>
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
            No terminal session selected
          </div>
        )}
      </div>
    </section>
  );
}
