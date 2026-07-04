/**
 * Provider context for active coding sub-agents, their readiness, and cap
 * pressure. The planner consumes this structural snapshot to decide whether a
 * turn should start a new session, reuse an idle worker, or wait for a stalled,
 * spend-capped, or round-trip-capped session to resolve.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  Service,
  State,
} from "@elizaos/core";
import { getAcpService } from "../actions/common.js";
import { TASK_WATCHDOG_SERVICE_TYPE } from "../services/task-watchdog-service.js";
import {
  type SessionInfo,
  TERMINAL_SESSION_STATUSES,
} from "../services/types.js";

type ApproachingCapKind = "round-trip" | "spend";

/** Read the watchdog's current stalled-session set (empty when unavailable). */
function stalledSessionIds(runtime: IAgentRuntime): Set<string> {
  const watchdog = runtime.getService<
    Service & { getStalledSessionIds?: () => string[] }
  >(TASK_WATCHDOG_SERVICE_TYPE);
  if (!watchdog || typeof watchdog.getStalledSessionIds !== "function") {
    return new Set();
  }
  try {
    return new Set(watchdog.getStalledSessionIds());
  } catch {
    // error-policy:J4 watchdog is optional; an unavailable getter degrades to no stalled set (a supplementary planner signal, not the session list itself)
    return new Set();
  }
}

/** Read the watchdog's approaching-cap sessions (empty when unavailable).
 * round-trip wins over spend when a session crosses both — it is the
 * runaway-loop signal the planner should act on first. */
function approachingCapBySession(
  runtime: IAgentRuntime,
): Map<string, ApproachingCapKind> {
  const map = new Map<string, ApproachingCapKind>();
  const watchdog = runtime.getService<
    Service & {
      getApproachingCapSessionIds?: () => Array<{
        id: string;
        kind: ApproachingCapKind;
      }>;
    }
  >(TASK_WATCHDOG_SERVICE_TYPE);
  if (!watchdog || typeof watchdog.getApproachingCapSessionIds !== "function") {
    return map;
  }
  try {
    for (const { id, kind } of watchdog.getApproachingCapSessionIds()) {
      if (!map.has(id) || kind === "round-trip") map.set(id, kind);
    }
  } catch {
    // error-policy:J4 watchdog is optional; an unavailable getter degrades to no approaching-cap set (a supplementary planner signal, not the session list itself)
    return new Map();
  }
  return map;
}

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
    let all: SessionInfo[] | undefined;
    try {
      all = await Promise.resolve(service.listSessions());
    } catch (error) {
      // error-policy:J4 the session list is the ground truth the planner reads
      // to decide spawn-vs-reuse-vs-wait; a failed load must NOT read as "no
      // sub-agents" (that would let the planner spawn a duplicate over a
      // still-running worker). Surface it observably via reportError and
      // degrade to an explicit "temporarily unavailable" note.
      runtime.reportError(PROVIDER_NAME, error, { operation: "listSessions" });
      return unavailableResult();
    }
    // Provider surfaces ONLY active sessions — the sub-agent currently
    // running is the ground truth. Past sessions (any terminal status,
    // including errored) are intentionally excluded: surfacing them mixes
    // historical noise with current state and lets the planner LLM
    // generalize past failures as predictors for new spawns. If the user
    // asks about history, the planner must call TASKS_HISTORY explicitly.
    const routed = (Array.isArray(all) ? all : [])
      .filter(hasOrigin)
      .filter((s) => !TERMINAL_SESSION_STATUSES.has(s.status));
    if (routed.length === 0) return emptyResult();

    routed.sort((a, b) => a.id.localeCompare(b.id));

    // Surface the watchdog's stalled set (#8901) so the planner can see which
    // sessions have gone quiet and decide whether to prod or stop them, plus the
    // approaching-cap set so it can stop/redirect before the loop guard force-stops.
    const stalled = stalledSessionIds(runtime);
    const approaching = approachingCapBySession(runtime);

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
            const raw = await service.getSessionOutput?.(session.id, 20);
            if (typeof raw !== "string") return;
            const tail = summarizeOutputTail(raw);
            if (tail) liveByName.set(session.id, tail);
          } catch {
            // error-policy:J4 live-tail is per-session enrichment; unavailable output degrades to structural status only
            // ignore — fall back to structural status only
          }
        }),
      );
    }

    const lines = [
      "## Active sub-agent sessions",
      "Each line is a live sub-agent. Reply to one with SEND_TO_AGENT { sessionId, text }; terminate with STOP_AGENT { sessionId }. Replying to the user uses the standard REPLY action; you may do both in one turn.",
      "The sub-agent's task_complete event is the ground truth for outcomes. For history about past sub-agents, call TASKS_HISTORY explicitly.",
    ];
    for (const session of routed) {
      lines.push(
        formatLine(
          session,
          liveByName.get(session.id),
          stalled.has(session.id),
          approaching.get(session.id),
        ),
      );
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
          stalled: stalled.has(s.id),
          approachingCap: approaching.get(s.id) ?? null,
          workdirTail: workdirTail(s.workdir),
          originRoomId: (s.metadata as Record<string, unknown> | undefined)
            ?.roomId,
          originUserId: (s.metadata as Record<string, unknown> | undefined)
            ?.userId,
        })),
      },
    };
  },
};

function emptyResult() {
  return {
    text: "",
    values: { activeSubAgents: "" },
    data: { sessions: [] },
  };
}

// Distinct from emptyResult: the load failed, so the planner must NOT treat the
// absence of listed sessions as "no active sub-agents". The note keeps the
// failure visible in-context (the reportError call already surfaced it via
// RECENT_ERRORS) so a duplicate spawn over a live worker is avoided.
function unavailableResult() {
  const text =
    "## Active sub-agent sessions\nSub-agent session state is temporarily unavailable (failed to load). Do not assume there are no active sub-agents — retry before spawning a new one.";
  return {
    text,
    values: { activeSubAgents: text },
    data: { sessions: [], unavailable: true },
  };
}

function hasOrigin(session: SessionInfo): boolean {
  const meta = session.metadata as Record<string, unknown> | undefined;
  if (!meta) return false;
  const roomId = meta.roomId;
  return typeof roomId === "string" && roomId.length > 0;
}

function formatLine(
  session: SessionInfo,
  live?: string,
  stalled?: boolean,
  approachingCap?: ApproachingCapKind,
): string {
  const label = labelOf(session);
  const tail = workdirTail(session.workdir);
  const bucket = stalled ? "stalled" : bucketStatus(session.status);
  const cap = approachingCap ? ` approachingCap=${approachingCap}` : "";
  const base = `- [${label}] sessionId=${session.id} agentType=${session.agentType} status=${bucket}${cap} workdir=…${tail}`;
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
