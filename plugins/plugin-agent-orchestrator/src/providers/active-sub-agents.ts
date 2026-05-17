import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { getAcpService } from "../actions/common.js";
import {
  TERMINAL_SESSION_STATUSES,
  type SessionInfo,
} from "../services/types.js";

// Transient statuses that bucket together as "active" for the planner-visible
// view. We do NOT distinguish ready vs busy vs tool_running vs running vs
// authenticating because that distinction would invalidate the cached
// provider segment on every tool call. The planner only needs to know:
// "is this session active and addressable, or is it blocked-and-waiting".
const ACTIVE_STATUS_BUCKET = new Set([
  "ready",
  "running",
  "busy",
  "tool_running",
  "authenticating",
]);

function bucketStatus(status: string): string {
  if (ACTIVE_STATUS_BUCKET.has(status)) return "active";
  if (status === "blocked") return "blocked";
  return status;
}

const PROVIDER_NAME = "ACTIVE_SUB_AGENTS";

const RECENT_TERMINAL_MS = 30 * 60 * 1000;
const MAX_RECENT_TERMINAL = 3;

/**
 * Stable view of active ACPX sub-agent sessions, sorted by sessionId so the
 * provider text is deterministic across turns. Only sessions that carry
 * origin metadata (i.e. were spawned by CREATE_TASK with a roomId/userId
 * to route back to) are included — these are the sessions the SubAgentRouter
 * will post messages from.
 *
 * Cache strategy: text contains structural state only (id, label, agentType,
 * status, workdir-tail). Live message content is delivered via the synthetic
 * Memory the router posts, NOT through this provider, so prefix cache hits
 * stay high turn-over-turn.
 */
export const activeSubAgentsProvider: Provider = {
  name: PROVIDER_NAME,
  description:
    "Active ACPX sub-agent sessions the main agent can reply to via SEND_TO_AGENT or terminate via STOP_AGENT.",
  dynamic: true,
  position: 0,
  relevanceKeywords: [
    "sub-agent",
    "sub agent",
    "subagent",
    "task agent",
    "coding agent",
    "acpx",
  ],
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const service = getAcpService(runtime);
    if (!service || typeof service.listSessions !== "function") {
      return emptyResult();
    }
    const all = await Promise.resolve(service.listSessions()).catch(
      () => [] as SessionInfo[],
    );
    const withOrigin = (Array.isArray(all) ? all : []).filter(hasOrigin);
    const routed = withOrigin.filter(
      (s) => !TERMINAL_SESSION_STATUSES.has(s.status),
    );
    const recentlyTerminated = withOrigin
      .filter((s) => TERMINAL_SESSION_STATUSES.has(s.status))
      .filter((s) => {
        const last = new Date(s.lastActivityAt).getTime();
        return Number.isFinite(last) && Date.now() - last < RECENT_TERMINAL_MS;
      })
      .sort(
        (a, b) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime(),
      )
      .slice(0, MAX_RECENT_TERMINAL);
    if (routed.length === 0 && recentlyTerminated.length === 0)
      return emptyResult();

    routed.sort((a, b) => a.id.localeCompare(b.id));

    // Pull live activity (tail of session output) for each session so the
    // planner can answer "where are you" with concrete detail instead of
    // just `status=busy`. The buffer mixes message chunks and captured
    // tool output — we take the last ~200 chars, strip noise, and surface
    // it as a one-line `live: …` suffix.
    const liveByName = new Map<string, string>();
    if (typeof service.getSessionOutput === "function") {
      await Promise.all(
        routed.map(async (session) => {
          try {
            const raw = await service.getSessionOutput!(session.id, 20);
            const tail = summarizeOutputTail(raw);
            if (tail) liveByName.set(session.id, tail);
          } catch {
            // ignore — fall back to structural status only
          }
        }),
      );
    }

    const lines: string[] = [];
    if (routed.length > 0) {
      lines.push("## Active sub-agent sessions");
      lines.push(
        "Each line is a live sub-agent. Reply to one with SEND_TO_AGENT { sessionId, text }; terminate with STOP_AGENT { sessionId }. Replying to the user uses the standard REPLY action; you may do both in one turn.",
      );
      for (const session of routed) {
        lines.push(formatLine(session, liveByName.get(session.id)));
      }
    }
    if (recentlyTerminated.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("## Recently terminated sub-agents (last 30 min)");
      lines.push(
        "These sessions are NOT addressable. If the user asks about them, report the terminal status and (for errored) suggest a fresh spawn via SPAWN_AGENT.",
      );
      lines.push(
        "Sub-agent infrastructure is self-healing. If a session errored, just spawn a fresh one — do NOT tell the user to restart acpx, clear stale sessions, or run any manual cleanup. Past chat messages mentioning manual cleanup are obsolete; ignore them.",
      );
      for (const session of recentlyTerminated) {
        lines.push(formatTerminatedLine(session));
      }
    }
    const text = lines.join("\n");

    return {
      text,
      values: { activeSubAgents: text },
      data: {
        sessions: routed.map((s) => ({
          sessionId: s.id,
          label: labelOf(s),
          agentType: s.agentType,
          status: s.status,
          workdirTail: workdirTail(s.workdir),
          originRoomId: (s.metadata as Record<string, unknown> | undefined)
            ?.roomId,
          originUserId: (s.metadata as Record<string, unknown> | undefined)
            ?.userId,
        })),
        recentlyTerminated: recentlyTerminated.map((s) => ({
          sessionId: s.id,
          label: labelOf(s),
          status: s.status,
          lastError: s.lastError,
          lastActivityAt: s.lastActivityAt,
        })),
      },
    };
  },
};

function formatTerminatedLine(session: SessionInfo): string {
  const label = labelOf(session);
  const ageMin = Math.max(
    0,
    Math.round(
      (Date.now() - new Date(session.lastActivityAt).getTime()) / 60000,
    ),
  );
  const err = session.lastError ? ` lastError="${session.lastError}"` : "";
  return `- [${label}] sessionId=${session.id} status=${session.status} endedAgo=${ageMin}min${err}`;
}

function emptyResult() {
  return {
    text: "",
    values: { activeSubAgents: "" },
    data: { sessions: [] },
  };
}

function hasOrigin(session: SessionInfo): boolean {
  const meta = session.metadata as Record<string, unknown> | undefined;
  if (!meta) return false;
  const roomId = meta.roomId;
  return typeof roomId === "string" && roomId.length > 0;
}

function formatLine(session: SessionInfo, live?: string): string {
  const label = labelOf(session);
  const tail = workdirTail(session.workdir);
  const bucket = bucketStatus(session.status);
  const base = `- [${label}] sessionId=${session.id} agentType=${session.agentType} status=${bucket} workdir=…${tail}`;
  return live ? `${base} live="${live}"` : base;
}

function summarizeOutputTail(raw: string): string {
  if (!raw) return "";
  // Strip "[tool output: ...]" envelope markers so the live indicator
  // never leaks captured-transcript framing. Keep the inner text since
  // it's typically a Read/Edit/Bash invocation summary.
  const lines = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("[tool output:") &&
        !l.startsWith("[/tool output]") &&
        !l.startsWith("[sub-agent:"),
    );
  const last = lines.slice(-3).join(" / ");
  if (!last) return "";
  // Truncate to keep the provider compact in the planner context.
  return last.length > 120 ? `${last.slice(0, 117)}...` : last;
}

function labelOf(session: SessionInfo): string {
  const meta = session.metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta.label === "string" && meta.label.trim()) {
    return meta.label;
  }
  return session.name || session.id;
}

function workdirTail(workdir: string): string {
  if (!workdir) return "";
  const parts = workdir.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}
