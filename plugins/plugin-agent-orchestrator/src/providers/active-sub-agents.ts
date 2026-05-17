import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { getAcpService } from "../actions/common.js";
import type { SessionInfo } from "../services/types.js";

const TERMINAL_STATUSES = new Set([
  "stopped",
  "completed",
  "error",
  "errored",
  "cancelled",
]);

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
    const all = await Promise.resolve(service.listSessions()).catch(
      () => [] as SessionInfo[],
    );
    const routed = (Array.isArray(all) ? all : [])
      .filter(hasOrigin)
      .filter((s) => !TERMINAL_STATUSES.has(s.status));
    if (routed.length === 0) return emptyResult();

    routed.sort((a, b) => a.id.localeCompare(b.id));

    const lines = [
      "## Active sub-agent sessions",
      "Each line is a live sub-agent. Reply to one with SEND_TO_AGENT { sessionId, text }; terminate with STOP_AGENT { sessionId }. Replying to the user uses the standard REPLY action; you may do both in one turn.",
    ];
    for (const session of routed) {
      lines.push(formatLine(session));
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

function hasOrigin(session: SessionInfo): boolean {
  const meta = session.metadata as Record<string, unknown> | undefined;
  if (!meta) return false;
  const roomId = meta.roomId;
  return typeof roomId === "string" && roomId.length > 0;
}

function formatLine(session: SessionInfo): string {
  const label = labelOf(session);
  const tail = workdirTail(session.workdir);
  const bucket = bucketStatus(session.status);
  return `- [${label}] sessionId=${session.id} agentType=${session.agentType} status=${bucket} workdir=…${tail}`;
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
