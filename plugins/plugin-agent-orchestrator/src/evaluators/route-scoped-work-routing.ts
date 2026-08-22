/**
 * Deterministic stage-1 routing for work the user scopes to a configured
 * workdir route ("in the milady-fork repo, count the .ts files under apps/").
 * Stage-1 routinely answers such asks with the parent's OWN shell (which runs
 * in the agent's cwd — `find milady-fork/apps` then fails) or by re-reading a
 * stale attachment, and the user hears "finished successfully with exit code
 * 0" / "that folder isn't there" (live 2026-08-22). The routed repo is only
 * reachable through the TASKS surface (its spawn resolves the route's
 * workdir), so a route-scoped work ask without a delegation candidate is
 * narrowed to TASKS.
 */
import type { Memory, ResponseHandlerEvaluator } from "@elizaos/core";
import { unwrapUserMessageText } from "@elizaos/core";
import { resolveWorkdirRoute } from "../services/task-agent-routing.js";

const DELEGATION_CLASS_RE =
  /^(?:tasks(?:_[a-z_]+)?|spawn_agent|spawn_coding_agent|start_coding_task|send_to_agent|create_agent_task)$/i;
/** Something to DO in the repo, as opposed to talk about it. */
const WORK_VERB_RE =
  /\b(?:count|list|find|look(?:\s+up)?|check|show|read|grep|search|inspect|fix|add|update|change|edit|write|run|test|build|create|remove|delete|rename|refactor|review|audit|bump|lint|format|commit|diff|compare|measure|how many)\b/i;

function messageText(message: Memory): string {
  return unwrapUserMessageText(message).trim();
}

export const routeScopedWorkRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.route-scoped-work-routing",
  description:
    "Work scoped to a configured workdir route runs through TASKS, never the parent's own shell.",
  priority: 20,
  shouldRun: ({ message }) => messageText(message).length > 0,
  evaluate: ({ runtime, message, messageHandler }) => {
    if (messageHandler.processMessage !== "RESPOND") return undefined;
    const candidates = Array.isArray(messageHandler.plan.candidateActions)
      ? messageHandler.plan.candidateActions.map((name) => String(name))
      : [];
    if (candidates.some((name) => DELEGATION_CLASS_RE.test(name.trim()))) {
      return undefined;
    }
    const text = messageText(message);
    if (!WORK_VERB_RE.test(text)) return undefined;
    const route = resolveWorkdirRoute(runtime, text, text);
    if (!route) return undefined;
    return {
      requiresTool: true,
      setContexts: ["code"],
      clearCandidateActions: true,
      addCandidateActions: ["TASKS"],
      debug: [
        `route-scoped work (route ${route.id}): candidates [${candidates.join(", ")}] replaced with TASKS`,
      ],
    };
  },
};
