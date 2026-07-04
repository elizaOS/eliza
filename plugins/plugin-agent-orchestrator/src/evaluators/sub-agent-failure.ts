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
  type MessageHandlerResult,
  type ResponseHandlerEvaluator,
  SIMPLE_CONTEXT_ID,
} from "@elizaos/core";

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
  return TERMINAL_FAILURE_EVENTS.has(textOf(metadata.subAgentEvent));
}

// Trim the router's error narration to a single short, user-readable clause:
// drop leading label/emoji/quote annotations and skip bare internal codes.
function shortReason(body: string): string {
  const firstLine = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^[\s>*•-]+/, "")
        .replace(/^\[[^\]]*\]\s*/, "")
        .trim(),
    )
    .find((line) => line.length > 0 && /\s/.test(line));
  if (!firstLine) return "";
  // First sentence only, with trailing sentence punctuation stripped so the
  // reply template's own period doesn't double up ("timed out.. Want me…").
  const clause = firstLine
    .split(/(?<=[.!?])\s/)[0]
    .replace(/[.!?]+$/, "")
    .trim();
  return clause.length > 160 ? `${clause.slice(0, 157)}…` : clause;
}

function buildFailureReply(label: string, reason: string): string {
  const what = label ? `the "${label}" task` : "that task";
  const because = reason ? ` — ${reason}` : "";
  return `Couldn't finish ${what}${because}. Want me to retry?`;
}

function respondIfNeeded(messageHandler: MessageHandlerResult) {
  return messageHandler.processMessage === "RESPOND"
    ? {}
    : { processMessage: "RESPOND" as const };
}

/**
 * Response-handler evaluator that guarantees a sub-agent terminal FAILURE never
 * lands as silence. The completion evaluator (`sub-agent-completion`) routes
 * `task_complete`; this is its failure-side twin for the `error` /
 * `state_lost_exhausted` / `round_trip_cap_exceeded` synthetics the router
 * emits but nothing handled. When the planner is taking a concrete follow-up of
 * its own (feeding the still-running session input, or a real next step) we
 * defer to it; otherwise we relay one honest line so the user gets an outcome
 * instead of a dangling spawn ack.
 */
export const subAgentFailureResponseEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.sub-agent-failure",
  description:
    "Routes terminal sub-agent failure synthetics (error / state-lost / round-trip-cap) to one honest user-facing message instead of silence.",
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
    const metadata = metadataRecord(message) ?? {};
    const label = textOf(metadata.subAgentLabel);
    const reason = shortReason(textOf(contentRecord(message)?.text));
    return {
      ...respondIfNeeded(messageHandler),
      requiresTool: false,
      setContexts: [SIMPLE_CONTEXT_ID],
      clearCandidateActions: true,
      clearParentActionHints: true,
      reply: buildFailureReply(label, reason),
      debug: [
        `sub-agent terminal failure (${textOf(
          metadata.subAgentEvent,
        )}); relaying one honest failure message instead of leaving the spawn ack dangling`,
      ],
    };
  },
};
