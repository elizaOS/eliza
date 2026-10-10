/**
 * Response-handler evaluator that fires when a coding sub-agent dies without
 * delivering — a hard ACP error, an exhausted state-recovery budget, or a
 * force-stopped ping-pong loop — as stamped onto a synthetic inbound memory by
 * the SubAgentRouter. It synthesizes a planner-ready failure turn so the parent
 * agent replies with the outcome instead of leaving the user staring at the
 * spawn acknowledgement in silence. The success counterpart is the
 * `task_complete` completion evaluator; this covers the terminal-failure events
 * that otherwise had no response handler.
 */
import {
  MESSAGE_SOURCE_SUB_AGENT,
  type Memory,
  type ResponseHandlerEvaluator,
} from "@elizaos/core";
import { SIMPLE_CONTEXT_ID } from "@elizaos/plugin-assistant";
import {
  completionHasVerificationFailure,
  verifiedUrlsExcludingDead,
} from "./sub-agent-completion.js";

const SUB_AGENT_SOURCE = MESSAGE_SOURCE_SUB_AGENT;

// Terminal failure events the SubAgentRouter stamps onto a synthetic inbound
// when a coding sub-agent dies WITHOUT delivering: a hard ACP error, an
// exhausted state-recovery budget, or a force-stopped ping-pong loop. Unlike
// `task_complete`, none of these had a response-handler evaluator, so the
// planner saw the error synthetic and frequently produced no reply — the user
// was left staring at the spawn ack with no outcome ("working on it" → silence).
const TERMINAL_FAILURE_EVENTS = new Set([
  "error",
  "state_lost_exhausted",
  "round_trip_cap_exceeded",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function contentRecord(message: Memory): Record<string, unknown> | undefined {
  return asRecord(message.content);
}

function metadataRecord(message: Memory): Record<string, unknown> | undefined {
  return asRecord(contentRecord(message)?.metadata);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasStrings(value: unknown): boolean {
  return (
    Array.isArray(value) && value.some((entry) => textOf(entry).length > 0)
  );
}

function normalizedActionHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => textOf(entry).toUpperCase())
    .filter((entry) => entry.length > 0);
}

function hasOnlyStaleFailureHints(value: unknown): boolean {
  const hints = normalizedActionHints(value);
  return (
    hints.length > 0 &&
    hints.every(
      (hint) =>
        hint === "TASKS" ||
        hint === "ATTACHMENT" ||
        hint === "SPAWN_AGENT" ||
        hint === "TASKS_CREATE" ||
        hint === "TASKS_CREATE_TASK" ||
        hint === "TASKS_SPAWN_AGENT" ||
        hint === "TASKS_SPAWN_TASK_AGENT",
    )
  );
}

function isTerminalSubAgentFailure(message: Memory): boolean {
  const content = contentRecord(message);
  const metadata = metadataRecord(message);
  if (!content || !metadata) return false;
  const source = textOf(content.source).toLowerCase();
  if (source !== SUB_AGENT_SOURCE && metadata.subAgent !== true) return false;
  const event = textOf(metadata.subAgentEvent);
  if (TERMINAL_FAILURE_EVENTS.has(event)) return true;
  // A task_complete stamped with the router's verification-failure annotation
  // and no URL that actually probed live delivered nothing usable — in user
  // terms a terminal failure. The completion evaluator steps aside for this
  // shape (its gate requires a live URL to relay), so without this twin the
  // outcome rides on the planner model volunteering a reply.
  if (event !== "task_complete") return false;
  const text = textOf(content.text);
  return (
    completionHasVerificationFailure(text) &&
    verifiedUrlsExcludingDead(message, text).length === 0
  );
}

/**
 * Response-handler evaluator that guarantees a sub-agent terminal FAILURE never
 * lands as silence. The completion evaluator (`sub-agent-completion`) routes
 * `task_complete`; this is its failure-side twin for the `error` /
 * `state_lost_exhausted` / `round_trip_cap_exceeded` synthetics the router
 * emits but nothing handled. When the planner is taking a concrete follow-up of
 * its own (feeding the still-running session input, or a real next step) we
 * defer to it; otherwise the turn answers with one model-phrased failure
 * message so the user gets an outcome instead of a dangling spawn ack. The
 * router relays at most one failure per task lineage.
 */
export const subAgentFailureResponseEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.sub-agent-failure",
  description:
    "Routes terminal sub-agent failure synthetics (error / state-lost / round-trip-cap) to one model-phrased user-facing message instead of silence.",
  priority: 10,
  shouldRun: ({ message, messageHandler }) => {
    if (!isTerminalSubAgentFailure(message)) return false;
    if (messageHandler.processMessage === "STOP") return false;
    // If the planner is taking a concrete follow-up action of its own, let it
    // own the turn rather than overriding with a generic failure line.
    const hasConcreteCandidateAction =
      hasStrings(messageHandler.plan.candidateActions) &&
      !hasOnlyStaleFailureHints(messageHandler.plan.candidateActions);
    const hasConcreteParentHint =
      hasStrings(messageHandler.plan.parentActionHints) &&
      !hasOnlyStaleFailureHints(messageHandler.plan.parentActionHints);
    if (hasConcreteCandidateAction || hasConcreteParentHint) {
      return false;
    }
    return true;
  },
  evaluate: ({ message, messageHandler }) => {
    const event = textOf(metadataRecord(message)?.subAgentEvent);
    // The model phrases the failure: Stage 1's reply ships when present,
    // otherwise the planner composes it from the turn's own facts, without the
    // orchestration tools a failure turn must not re-run.
    const hasStageOneReply = textOf(messageHandler.plan.reply).length > 0;
    return {
      processMessage: "RESPOND",
      requiresTool: false,
      setContexts: [hasStageOneReply ? SIMPLE_CONTEXT_ID : "general"],
      clearCandidateActions: true,
      clearParentActionHints: true,
      debug: [
        hasStageOneReply
          ? `sub-agent terminal failure (${event}); relaying the model's reply as the one failure message`
          : `sub-agent terminal failure (${event}) with no Stage-1 reply; the planner phrases the one failure message`,
      ],
    };
  },
};
