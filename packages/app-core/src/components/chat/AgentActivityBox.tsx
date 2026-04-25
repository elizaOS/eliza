import type { CodingAgentSession } from "../../api/client-types-cloud";
import {
  PULSE_STATUSES,
  STATUS_DOT,
} from "../../chat/coding-agent-session-state";
import { useApp } from "../../state";

/** Derive activity text for sessions hydrated from the server (no lastActivity yet). */
function deriveActivity(
  s: CodingAgentSession,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (s.status === "tool_running" && s.toolDescription) {
    return t("agentactivitybox.RunningTool", {
      defaultValue: "Running {{tool}}",
      tool: s.toolDescription,
    }).slice(0, 60);
  }
  if (s.status === "blocked") {
    return t("agentactivitybox.WaitingForInput", {
      defaultValue: "Waiting for input",
    });
  }
  if (s.status === "error") {
    return t("common.error", { defaultValue: "Error" });
  }
  return t("appsview.Running", { defaultValue: "Running" });
}

interface AgentActivityBoxProps {
  sessions: CodingAgentSession[];
  onSessionClick?: (sessionId: string) => void;
}

export function AgentActivityBox({
  sessions,
  onSessionClick,
}: AgentActivityBoxProps) {
  const { t } = useApp();
  if (!sessions || sessions.length === 0) return null;

  return (
    <div className="px-3 py-2 space-y-1 z-[1] mb-2 relative rounded-2xl border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] shadow-[0_12px_36px_rgba(0,0,0,0.12)] ring-1 ring-inset ring-white/6 backdrop-blur-[22px]">
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          onClick={() => onSessionClick?.(s.sessionId)}
          className="flex items-center gap-1.5 min-w-0 w-full text-left cursor-pointer hover:bg-bg-hover rounded px-1 -mx-1 transition-colors"
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              STATUS_DOT[s.status] ?? "bg-muted"
            }${PULSE_STATUSES.has(s.status) ? " animate-pulse" : ""}`}
          />
          <span className="text-xs-tight font-medium text-txt max-w-[120px] truncate shrink-0">
            {s.label}
          </span>
          <span
            className={`text-xs-tight truncate min-w-0 flex-1 ${
              s.status === "error"
                ? "text-danger"
                : s.status === "blocked"
                  ? "text-warn"
                  : s.status === "active" || s.status === "tool_running"
                    ? "text-ok"
                    : "text-muted"
            }`}
          >
            {s.lastActivity ?? deriveActivity(s, t)}
          </span>
          {/* Chevron-up icon */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            focusable="false"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-muted"
          >
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
      ))}
    </div>
  );
}
