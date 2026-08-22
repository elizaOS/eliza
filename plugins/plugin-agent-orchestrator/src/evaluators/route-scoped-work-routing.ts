/**
 * Deterministic stage-1 routing for work the user scopes to a configured
 * workdir route ("in the milady-fork repo, count the .ts files under apps/").
 * Stage-1 routinely answers such asks with the parent's OWN shell, which runs
 * in the agent's cwd — `find milady-fork/apps` then fails and the user hears
 * "finished successfully with exit code 0" (live 2026-08-22). The routed
 * repo is only reachable through the TASKS surface (its spawn resolves the
 * route's workdir), so a shell-class candidate on a route-scoped ask is
 * replaced by TASKS.
 */
import type { Memory, ResponseHandlerEvaluator } from "@elizaos/core";
import { unwrapUserMessageText } from "@elizaos/core";
import { resolveWorkdirRoute } from "../services/task-agent-routing.js";

const SHELL_CLASS_RE =
  /^(?:terminal(?:_shell)?|shell|bash|exec|execute_command|run_command|run_shell|run_in_terminal|local_shell)$/i;

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
    const shellCandidates = candidates.filter((name) =>
      SHELL_CLASS_RE.test(name.trim()),
    );
    if (shellCandidates.length === 0) return undefined;
    const text = messageText(message);
    const route = resolveWorkdirRoute(runtime, text, text);
    if (!route) return undefined;
    return {
      requiresTool: true,
      setContexts: ["code"],
      clearCandidateActions: true,
      addCandidateActions: ["TASKS"],
      debug: [
        `route-scoped ask (route ${route.id}): replaced shell candidate(s) ${shellCandidates.join(", ")} with TASKS`,
      ],
    };
  },
};
