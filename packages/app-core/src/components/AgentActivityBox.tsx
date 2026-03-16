import type { CodingAgentSession } from "@elizaos/app-core/api";

/** Status dot color classes for coding-agent activity. */
const STATUS_DOT: Record<string, string> = {
  active: "bg-ok",
  tool_running: "bg-accent",
  blocked: "bg-warn",
  error: "bg-danger",
};

const PULSE_STATUSES = new Set(["active", "tool_running"]);

/** Derive activity text for sessions hydrated from the server (no lastActivity yet). */
function deriveActivity(s: CodingAgentSession): string {
  if (s.status === "tool_running" && s.toolDescription) {
    return `Running ${s.toolDescription}`.slice(0, 60);
  }
  if (s.status === "blocked") return "Waiting for input";
  if (s.status === "error") return "Error";
  return "Running";
}

interface AgentActivityBoxProps {
  sessions: CodingAgentSession[];
}

export function AgentActivityBox({ sessions }: AgentActivityBoxProps) {
  if (!sessions || sessions.length === 0) return null;

  return (
    <div className="border-t border-border px-3 py-1.5 space-y-0.5 z-[1]">
      {sessions.map((s) => (
        <div key={s.sessionId} className="flex items-center gap-1.5 min-w-0">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              STATUS_DOT[s.status] ?? "bg-muted"
            }${PULSE_STATUSES.has(s.status) ? " animate-pulse" : ""}`}
          />
          <span className="text-[11px] font-medium text-txt max-w-[120px] truncate shrink-0">
            {s.label}
          </span>
          <span className="text-[11px] text-muted truncate min-w-0">
            {s.lastActivity ?? deriveActivity(s)}
          </span>
        </div>
      ))}
    </div>
  );
}
