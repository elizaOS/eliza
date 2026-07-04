/**
 * Compact row of active coding-agent sessions rendered above the chat thread:
 * per-session status dot, label, and derived activity text, each clickable to
 * open that session. Activity text for server-hydrated sessions is synthesized
 * through the canonical `activityEventToPlaintext` serializer so this rail reads
 * the same as the live WebSocket activity stream. Renders nothing when idle.
 */
import { activityEventToPlaintext } from "@elizaos/core";
import type { CodingAgentSession } from "../../api/client-types-cloud";
import {
  PULSE_STATUSES,
  STATUS_DOT,
} from "../../chat/coding-agent-session-state";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";

/** Session statuses the canonical pty serializer turns into useful text. */
const SUMMARIZABLE_STATUSES = new Set<CodingAgentSession["status"]>([
  "tool_running",
  "blocked",
  "error",
]);

/**
 * Derive activity text for sessions hydrated from the server (no lastActivity
 * yet). Maps the session status onto a synthetic pty activity event and routes
 * it through the canonical `activityEventToPlaintext` serializer so the rail
 * speaks the same language as the live WebSocket stream (see
 * `useActivityEvents`). Statuses the serializer does not summarize fall back to
 * a localized "Running" label.
 */
function deriveActivity(
  s: CodingAgentSession,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const fallback = t("appsview.Running", { defaultValue: "Running" });
  if (!SUMMARIZABLE_STATUSES.has(s.status)) {
    return fallback;
  }
  const summary = activityEventToPlaintext(
    {
      eventType: s.status,
      sessionId: s.sessionId,
      ...(s.toolDescription
        ? { data: { description: s.toolDescription } }
        : {}),
    },
    { maxLength: 60 },
  );
  return summary?.plaintext ?? fallback;
}

interface AgentActivityBoxProps {
  sessions: CodingAgentSession[];
  onSessionClick?: (sessionId: string) => void;
}

export function AgentActivityBox({
  sessions,
  onSessionClick,
}: AgentActivityBoxProps) {
  const t = useAppSelector((s) => s.t);
  if (!sessions || sessions.length === 0) return null;

  return (
    <div className="px-3 py-2 space-y-1 z-[1] mb-2 relative rounded-sm border border-border bg-card ">
      {sessions.map((s) => (
        <Button
          key={s.sessionId}
          onClick={() => onSessionClick?.(s.sessionId)}
          variant="ghost"
          className="-mx-1 flex h-auto min-w-0 w-full items-center justify-start gap-1.5 whitespace-normal rounded-sm px-1 py-0 text-left font-normal transition-colors hover:bg-bg-hover"
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
        </Button>
      ))}
    </div>
  );
}
