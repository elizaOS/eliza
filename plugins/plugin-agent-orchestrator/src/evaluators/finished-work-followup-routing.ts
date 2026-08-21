/**
 * Deterministic stage-1 routing for run-it / show-me follow-ups aimed at
 * recently finished sub-agent work. The planner's model routing is not stable
 * here: with the finished lane's workdir already garbage-collected, the same
 * "run the lunch spot picker and show me what it prints" repeatedly chose a
 * direct SHELL against the dead path — even with an explicit "(cleaned up —
 * reopen via SEND_TO_AGENT)" provider line in context — and the turn ended in
 * an apology (live 2026-08-20, three attempts). The TASKS send/create surface
 * is the only route that reliably reopens finished work (its terminal-session
 * redirect rebuilds in a fresh workspace), so the candidate surface is
 * narrowed structurally whenever a fresh terminal lane exists and nothing is
 * running.
 */
import type { Memory, ResponseHandlerEvaluator } from "@elizaos/core";
import { getAcpService } from "../actions/common.js";
import { TERMINAL_SESSION_STATUSES } from "../services/types.js";

/** Run/show verb aimed at prior work ("it", "again", the/that <thing>) or an
 *  output ask. Bare coding asks ("write me a script") carry none of these. */
const RUN_FOLLOWUP_RE =
  /\b(?:run|execute|rerun|re-run)\b[\s\S]{0,60}\b(?:it|its|again|that|the)\b|\bshow\s+me\b[\s\S]{0,60}\b(?:output|result|prints?)\b|\bwhat\s+(?:does|did)\s+it\s+print\b/i;

const RECENT_TERMINAL_WINDOW_MS = 30 * 60_000;

function messageText(message: Memory): string {
  const content = message.content;
  return content && typeof content === "object" && "text" in content
    ? String((content as { text?: unknown }).text ?? "")
    : "";
}

export const finishedWorkFollowUpRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.finished-work-followup-routing",
  description:
    "Routes run-it/show-me follow-ups on finished sub-agent work to the TASKS surface deterministically.",
  priority: 20,
  shouldRun: ({ message }) => RUN_FOLLOWUP_RE.test(messageText(message)),
  evaluate: async ({ runtime, messageHandler }) => {
    if (messageHandler.processMessage !== "RESPOND") return undefined;
    const service = getAcpService(runtime);
    if (!service) return undefined;
    let sessions: Awaited<ReturnType<typeof service.listSessions>>;
    try {
      sessions = await Promise.resolve(service.listSessions());
    } catch {
      // error-policy:J4 routing enrichment only — an unavailable session list
      // leaves the planner's normal candidate surface untouched.
      return undefined;
    }
    const routed = (Array.isArray(sessions) ? sessions : []).filter((s) => {
      const meta = s.metadata as Record<string, unknown> | undefined;
      return typeof meta?.roomId === "string" && meta.roomId.length > 0;
    });
    // A live lane owns its own follow-up routing (send/queue paths).
    if (routed.some((s) => !TERMINAL_SESSION_STATUSES.has(s.status))) {
      return undefined;
    }
    const now = Date.now();
    const recentTerminal = routed.some((s) => {
      if (!TERMINAL_SESSION_STATUSES.has(s.status)) return false;
      const at = new Date(s.lastActivityAt ?? s.createdAt).getTime();
      return Number.isFinite(at) && now - at < RECENT_TERMINAL_WINDOW_MS;
    });
    if (!recentTerminal) return undefined;
    return {
      clearCandidateActions: true,
      addCandidateActions: ["TASKS", "TASKS_SEND", "TASKS_CREATE"],
      // TASKS' contextGate accepts automation; without it the planner can
      // reject the injected candidates as out-of-context.
      addContextSlices: ["automation"],
      debug: [
        "run-it follow-up on finished sub-agent work: candidate surface narrowed to TASKS (direct SHELL against a gc'd workspace is the proven failure mode)",
      ],
    };
  },
};
