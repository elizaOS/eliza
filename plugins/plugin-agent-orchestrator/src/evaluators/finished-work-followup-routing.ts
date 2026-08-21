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
import { extractWrappedExternalContent } from "@elizaos/core";
import { getAcpService } from "../actions/common.js";
import { TERMINAL_SESSION_STATUSES } from "../services/types.js";

/** Run/show verb aimed at prior work ("it", "again", the/that <thing>) or an
 *  output ask. Bare coding asks ("write me a script") carry none of these. */
const RUN_FOLLOWUP_RE =
  /\b(?:run|execute|rerun|re-run)\b[\s\S]{0,60}\b(?:it|its|again|that|the|once\s+more|one\s+more\s+time)\b|\bshow\s+me\b[\s\S]{0,60}\b(?:output|result|prints?)\b|\bwhat\s+(?:does|did)\s+it\s+print\b/i;

const RECENT_TERMINAL_WINDOW_MS = 30 * 60_000;

function messageText(message: Memory): string {
  const content = message.content;
  const raw =
    content && typeof content === "object" && "text" in content
      ? String((content as { text?: unknown }).text ?? "")
      : "";
  // API/webhook messages arrive wrapped in the untrusted-content envelope;
  // forwarding the wrapped text as a child task embedded the whole SECURITY
  // NOTICE banner, the child echoed it, and the outbound envelope guard then
  // blocked the completion (live 2026-08-21). Route on the verbatim payload.
  return (extractWrappedExternalContent(raw) ?? raw).trim();
}

export const finishedWorkFollowUpRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.finished-work-followup-routing",
  description:
    "Routes run-it/show-me follow-ups on finished sub-agent work to the TASKS surface deterministically.",
  priority: 20,
  deterministicActions: ["TASKS"],
  shouldRun: ({ message }) => RUN_FOLLOWUP_RE.test(messageText(message)),
  evaluate: async ({ runtime, message, messageHandler }) => {
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
      if (typeof meta?.roomId !== "string" || meta.roomId.length === 0) {
        return false;
      }
      // Quarantine lanes born from sprayed planner args (serialized param
      // junk in the label/task) — redirect chains otherwise propagate the
      // garbage title into every successor (live 2026-08-21).
      const label = `${String(meta.label ?? "")} ${String(meta.initialTask ?? "").slice(0, 200)}`;
      return !/appMonetized\s*[:=]|approvalPreset\s*[:=]/.test(label);
    });
    // A live lane owns its own follow-up routing (send/queue paths).
    if (routed.some((s) => !TERMINAL_SESSION_STATUSES.has(s.status))) {
      return undefined;
    }
    const now = Date.now();
    const recentTerminal = routed
      .filter((s) => TERMINAL_SESSION_STATUSES.has(s.status))
      .filter((s) => {
        const at = new Date(s.lastActivityAt ?? s.createdAt).getTime();
        return Number.isFinite(at) && now - at < RECENT_TERMINAL_WINDOW_MS;
      })
      .sort(
        (a, b) =>
          new Date(b.lastActivityAt ?? b.createdAt).getTime() -
          new Date(a.lastActivityAt ?? a.createdAt).getTime(),
      )[0];
    if (!recentTerminal) return undefined;
    const userText = messageText(message).trim();
    if (!userText) return undefined;
    // Fully deterministic: the model writes NO tool args. Candidate-narrowing
    // alone still let the planner fill the wide TASKS schema itself, and it
    // sprayed values into wrong params — a send whose `agents` field carried
    // serialized junk ("\"\"\",appMonetized:false,approvalPreset:") became a
    // garbage-labeled second lane (live 2026-08-21). runSend's terminal
    // redirect turns this into the merged successor create.
    return {
      deterministicToolCall: {
        name: "TASKS",
        params: {
          action: "send",
          sessionId: recentTerminal.id,
          input: userText,
        },
      },
      debug: [
        `run-it follow-up on finished sub-agent work: deterministic TASKS send to ${recentTerminal.id}`,
      ],
    };
  },
};
