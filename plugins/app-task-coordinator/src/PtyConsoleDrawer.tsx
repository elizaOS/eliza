import { type CodingAgentSession, useApp } from "@elizaos/ui";
import { PtyConsoleBase } from "./PtyConsoleBase";
import { PULSE_STATUSES, STATUS_DOT } from "./pty-status-dots";

interface PtyConsoleDrawerProps {
  activeSessionId: string | null;
  sessions: CodingAgentSession[];
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  onClose: () => void;
}

/**
 * Always-visible terminal panel below the chat composer.
 * Shows a compact tab bar with session list + "new session" button.
 * Clicking a session expands the terminal pane inline.
 */
export function PtyConsoleDrawer({
  activeSessionId,
  sessions,
  onSessionClick,
  onNewSession,
  onClose,
}: PtyConsoleDrawerProps) {
  const { t } = useApp();
  const isExpanded = activeSessionId != null;
  const hasSessions = sessions.length > 0;

  return (
    <div className="flex flex-col">
      {/* Tab bar — always visible */}
      <div className="flex items-center gap-0 px-2 min-h-[32px]">
        {sessions.map((s) => {
          const isActive = s.sessionId === activeSessionId;
          return (
            <button
              key={s.sessionId}
              type="button"
              onClick={() => onSessionClick(s.sessionId)}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors cursor-pointer border-b-2 ${
                isActive
                  ? "border-accent text-txt"
                  : "border-transparent text-muted hover:text-txt"
              }`}
            >
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                  STATUS_DOT[s.status] ?? "bg-muted"
                }${PULSE_STATUSES.has(s.status) ? " animate-pulse" : ""}`}
              />
              <span className="truncate max-w-[120px]">{s.label}</span>
              {s.status === "error" ? (
                <span className="text-danger text-2xs">
                  {t("common.error", { defaultValue: "Error" })}
                </span>
              ) : s.status === "blocked" ? (
                <span className="text-warn text-2xs">
                  {t("codingagenttaskspanel.status.blocked", {
                    defaultValue: "Blocked",
                  })}
                </span>
              ) : null}
            </button>
          );
        })}

        {/* New session button */}
        <button
          type="button"
          onClick={onNewSession}
          className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-txt transition-colors cursor-pointer border-b-2 border-transparent"
          aria-label={t("ptyconsolebase.NewTerminalSession", {
            defaultValue: "New terminal session",
          })}
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {!hasSessions && (
            <span>
              {t("ptyconsolebase.Terminal", {
                defaultValue: "Terminal",
              })}
            </span>
          )}
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Collapse button (only when expanded) */}
        {isExpanded && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted hover:text-txt transition-colors cursor-pointer"
            aria-label={t("ptyconsolebase.CollapseTerminal", {
              defaultValue: "Collapse terminal",
            })}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M7 13l5 5 5-5M7 6l5 5 5-5" />
            </svg>
          </button>
        )}
      </div>

      {/* Expanded terminal pane */}
      {isExpanded && (
        <div
          className="flex flex-col border-t border-border"
          style={{ height: "35vh", minHeight: 160, maxHeight: "50vh" }}
        >
          <PtyConsoleBase
            activeSessionId={activeSessionId}
            sessions={sessions}
            onClose={onClose}
            variant="drawer"
          />
        </div>
      )}
    </div>
  );
}
