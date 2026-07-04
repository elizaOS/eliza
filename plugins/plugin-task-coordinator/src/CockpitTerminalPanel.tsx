// Streams read-only PTY output into the cockpit session panel.
import { Button, type CodingAgentSession } from "@elizaos/ui";
import { TerminalSquare } from "lucide-react";
import { useState } from "react";

import { PtyConsoleBase } from "./PtyConsoleBase";
import { PtyTerminalPane } from "./PtyTerminalPane";

type TerminalMode = "pretty" | "cli";

export interface CockpitTerminalPanelProps {
  /** The PTY session id to attach to. `null`/empty renders the empty state. */
  activeSessionId: string | null;
  /** Live session roster — `PtyConsoleBase` resolves the active label/workdir. */
  sessions: CodingAgentSession[];
  /** Optional close affordance forwarded to the pretty console header. */
  onClose?: () => void;
}

/**
 * Coding-cockpit terminal panel with a pretty ⇄ CLI toggle.
 *
 *   - **pretty** → `PtyConsoleBase` (variant="full"): the buffered + streamed
 *     scrollback watch view with a single-line input + interrupt/stop controls.
 *   - **cli** → `PtyTerminalPane`: the raw xterm.js terminal.
 *
 * Both panes speak the same `pty-output` / `sendPtyInput` WS protocol against the
 * `activeSessionId`. When there is no active session the panel shows a tasteful
 * empty state instead of mounting a terminal.
 *
 * HONEST SCOPE — read-mostly today. Genuine interactive CLI (raw stdin reaching a
 * prompt so a live `/slash` executes) requires a runtime that registers a
 * `PTY_SERVICE` (node-pty) console bridge. No bundled plugin in this worktree
 * registers one — ACP sessions run `--no-terminal` and accept structured input,
 * not raw stdin — so against an ACP session both panes are effectively a
 * read-mostly watch surface (buffered + streamed output). The toggle ships as
 * that watch surface; interactive `/slash` must be proven separately on the
 * desktop / coding-agent build that backs `sendPtyInput` with a real PTY.
 */
export function CockpitTerminalPanel({
  activeSessionId,
  sessions,
  onClose,
}: CockpitTerminalPanelProps) {
  const [mode, setMode] = useState<TerminalMode>("pretty");
  const sessionId = activeSessionId ?? "";
  const hasSession = sessionId.length > 0;

  return (
    <div
      data-testid="cockpit-terminal-panel"
      className="flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border/70 bg-bg"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-black/20 px-3">
        <TerminalSquare className="h-4 w-4 shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
          Terminal
        </span>
        <div
          role="radiogroup"
          aria-label="Terminal view mode"
          className="inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-black/30 p-0.5"
        >
          <Button
            type="button"
            size="sm"
            variant={mode === "pretty" ? "default" : "ghost"}
            role="radio"
            aria-checked={mode === "pretty"}
            aria-pressed={mode === "pretty"}
            data-testid="cockpit-term-toggle-pretty"
            onClick={() => setMode("pretty")}
          >
            Pretty
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "cli" ? "default" : "ghost"}
            role="radio"
            aria-checked={mode === "cli"}
            aria-pressed={mode === "cli"}
            data-testid="cockpit-term-toggle-cli"
            onClick={() => setMode("cli")}
          >
            CLI
          </Button>
        </div>
      </header>

      <div className="relative h-80 min-h-0 w-full bg-black/40">
        {!hasSession ? (
          <div
            data-testid="cockpit-terminal-empty"
            className="flex h-full w-full flex-col items-center justify-center gap-1 px-6 text-center"
          >
            <TerminalSquare className="h-6 w-6 text-muted" aria-hidden />
            <p className="text-sm font-medium text-txt">No active session</p>
            <p className="text-xs text-muted">
              Start or select a coding session to attach a terminal.
            </p>
          </div>
        ) : mode === "pretty" ? (
          <PtyConsoleBase
            variant="full"
            activeSessionId={sessionId}
            sessions={sessions}
            onClose={onClose ?? noop}
          />
        ) : (
          <div data-testid="cockpit-term-cli" className="h-full w-full">
            <PtyTerminalPane sessionId={sessionId} visible={true} />
          </div>
        )}
      </div>
    </div>
  );
}

function noop(): void {
  // No-op default close handler when the host does not supply one.
}
