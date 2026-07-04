/**
 * Interruption decider for sub-agents sharing a task room.
 *
 * When a human posts in a task room while sub-agents are working, we must
 * decide — per participant — whether that message should INTERRUPT the
 * in-flight turn, be QUEUED for after it, be DELIVERED now (idle agent), or be
 * IGNORED (ambient chatter not meant for this agent).
 *
 * Eliza participants already have this faculty: the core `shouldRespond`
 * evaluator (RESPOND / IGNORE / STOP). Coding sub-agents (Claude Code, Codex,
 * OpenCode) have no such gate — left alone, every keystroke in the room is
 * injected into a running turn, derailing it. This module gives them an
 * equivalent structural decision, and threads an Eliza participant's
 * `shouldRespond` verdict through unchanged when one is supplied.
 *
 * Bias: a working sub-agent keeps working. We only INTERRUPT on an explicit
 * stop/redirect; otherwise relevant messages QUEUE and ambient ones are IGNORE.
 */

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { parseJsonObjectResponse } from "./json-model-output.js";

export type InterruptionAction = "deliver" | "queue" | "interrupt" | "ignore";

export interface InterruptionDecision {
  action: InterruptionAction;
  reason: string;
}

export interface InterruptionInput {
  /** The incoming user message text. */
  text: string;
  /** Sub-agent framework: claude / codex / opencode / elizaos / … */
  agentType: string;
  /** True when the sub-agent is mid-turn (ACP status `busy`). */
  sessionBusy: boolean;
  /** The sub-agent's person-name label, for addressing detection. */
  agentLabel?: string;
  /** An Eliza participant's core shouldRespond verdict, when available. */
  shouldRespond?: "RESPOND" | "IGNORE" | "STOP";
  /** True when the room has participants beyond the user + this sub-agent. */
  multiParty?: boolean;
  /** What the sub-agent is working on (task/goal), for the model classifier's
   *  relevance judgement. Ignored by the pure-regex {@link decideInterruption}. */
  taskContext?: string;
}

// Explicit "stop what you're doing" intent.
const STOP_PATTERN =
  /\b(stop|cancel|abort|halt|never ?mind|forget it|that'?s enough|quit it|kill it)\b/i;

// "stop <gerund>" is normally a code INSTRUCTION ("stop using axios", "stop
// importing lodash", "stop logging that") — it changes what the code does, not
// a command to halt the agent — so it must NOT cancel the in-flight turn (it
// queues and reaches the agent after its current turn). The exception is a
// gerund that refers to the AGENT itself ("stop working / doing / running"),
// which stays a genuine halt. Bare stops ("stop", "stop it", "Ada, stop") have
// no following gerund and are unaffected.
const STOP_CODE_INSTRUCTION_PATTERN =
  /\bstop\s+(?!working\b|doing\b|running\b|generating\b|responding\b|that\b|this\b|it\b|now\b|everything\b|all\b)\w+ing\b/i;

// Additive markers — the message AUGMENTS the current work rather than
// redirecting it, so it must never interrupt (even when it also contains a
// stop/correction token like "stop" or "don't forget"). "also add X", "and
// also", "while you're at it", etc.
const ADDITIVE_PATTERN =
  /\b(also|as well|in addition|additionally|plus,|and also|on top of|while you'?re at it|don'?t forget|too\b)\b/i;

// Course-correction intent — a directed negation/correction, NOT a bare
// "actually"/"don't" (which routinely appear in additive instructions). Only
// interrupts when the agent is mid-turn AND addressed AND not additive.
const REDIRECT_PATTERN =
  /\b(no,? (?:stop|don'?t|do not|not that)|that'?s wrong|that is wrong|wrong (?:approach|direction|file|way|thing)|scrap (?:that|this|it)|start over|undo (?:that|this|it)|revert (?:that|this|it)|instead of|change of plan|actually,? (?:stop|cancel|no|don'?t|do not|wait|hold|revert))\b/i;

function isAddressed(text: string, agentLabel?: string): boolean {
  if (text.includes("@")) return true;
  if (!agentLabel) return false;
  return new RegExp(`\\b${escapeRegExp(agentLabel)}\\b`, "i").test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decide what to do with a room message destined for a running sub-agent.
 * Pure and synchronous — the caller supplies the (already known) session state.
 */
export function decideInterruption(
  input: InterruptionInput,
): InterruptionDecision {
  const text = input.text.trim();
  if (!text) return { action: "ignore", reason: "empty" };

  // Eliza participants defer to the core shouldRespond verdict.
  if (input.shouldRespond) {
    switch (input.shouldRespond) {
      case "STOP":
        return { action: "interrupt", reason: "shouldRespond=STOP" };
      case "IGNORE":
        return { action: "ignore", reason: "shouldRespond=IGNORE" };
      default:
        return input.sessionBusy
          ? { action: "queue", reason: "shouldRespond=RESPOND while busy" }
          : { action: "deliver", reason: "shouldRespond=RESPOND" };
    }
  }

  const addressed = isAddressed(text, input.agentLabel);
  const additive = ADDITIVE_PATTERN.test(text);

  // Explicit stop interrupts (busy or not), unless the message is really an
  // additive request that merely mentions stopping ("stop, and also add X").
  // In a multi-party room, an UNADDRESSED stop is ambient chatter from another
  // participant — it must not cancel this agent's turn (only an addressed stop,
  // or any stop in a solo room, interrupts).
  if (
    STOP_PATTERN.test(text) &&
    !STOP_CODE_INSTRUCTION_PATTERN.test(text) &&
    !additive &&
    !(input.multiParty && !addressed)
  ) {
    return { action: "interrupt", reason: "explicit stop/cancel" };
  }

  if (!input.sessionBusy) {
    // Idle agent: an unaddressed ambient line in a crowded room is not for it.
    if (input.multiParty && !addressed) {
      return { action: "ignore", reason: "ambient chatter, agent idle" };
    }
    return { action: "deliver", reason: "agent idle" };
  }

  // Agent is mid-turn from here on — default is to NOT disrupt it. Only a
  // directed, non-additive course-correction cancels the in-flight turn.
  if (addressed && !additive && REDIRECT_PATTERN.test(text)) {
    return { action: "interrupt", reason: "addressed course-correction" };
  }
  if (input.multiParty && !addressed) {
    return { action: "ignore", reason: "ambient chatter during turn" };
  }
  return { action: "queue", reason: "relevant; deliver after current turn" };
}

// ── Model-backed classifier ─────────────────────────────────────────────────
//
// The regex decider above is a fast, deterministic pre-filter, but it reasons
// only over English surface patterns: it cannot tell an intent-level halt
// ("wait, this is all wrong") from an additive aside, nor a direction-changing
// redirect ("actually target Postgres") from a code-content instruction ("stop
// using axios"), and it is English-only. For the decision-critical cases — a
// sub-agent mid-turn, or a crowded room where directedness matters — we ask a
// small model to classify the message's intent toward the running agent with
// full task context. It returns the 4-way action directly (a superset of the
// core RESPOND/IGNORE/STOP verdict, which cannot express "interrupt to
// redirect"). The regex decision remains the fallback whenever the model is
// unavailable or returns an unparseable verdict, so behavior only ever improves.

function buildInterruptionClassifierPrompt(input: InterruptionInput): string {
  const label = input.agentLabel?.trim() || input.agentType;
  const work = input.taskContext?.trim()
    ? input.taskContext.trim().slice(0, 500)
    : "a coding task";
  const state = input.sessionBusy
    ? "MID-TURN (actively generating or running a tool right now)"
    : "IDLE (between turns)";
  const room = input.multiParty
    ? "multiple participants — a message may be directed at someone else, not this agent"
    : "just the user and this agent";
  return [
    "You are the interruption controller for an autonomous coding sub-agent in a shared chat room.",
    "A human just posted a message. Decide what to do with it relative to the sub-agent's IN-PROGRESS work.",
    "",
    `Sub-agent: ${label} (${input.agentType}), working on: ${work}`,
    `State: ${state}`,
    `Room: ${room}`,
    "",
    `Incoming message: """${input.text.trim().slice(0, 800)}"""`,
    "",
    "Choose EXACTLY one action:",
    '- "interrupt": stop or change direction RIGHT NOW — an explicit halt ("stop", "cancel", "wait"), or a redirect that invalidates the work in progress ("no, use Postgres not MySQL", "scrap that, start over"). Reserve for genuine halts/redirects worth cancelling live work for.',
    '- "queue": a RELEVANT instruction or addition that should reach the agent AFTER the current turn — including code-content instructions like "stop using axios", "don\'t import lodash", "also add tests", "make the header sticky too". These change what the code does; they are NOT a command to halt the agent.',
    '- "deliver": the agent is idle and this message is for it — send it now.',
    '- "ignore": chatter not meant for this agent — acknowledgements ("nice", "thanks", "lgtm"), or (in a crowded room) messages addressed to someone else or unrelated to the task.',
    "",
    'Bias: a working sub-agent keeps working. Prefer "queue" over "interrupt" unless the message is a genuine halt or a direction-invalidating redirect. Never choose "interrupt" merely because the text contains the word "stop" — judge intent.',
    "",
    'Respond with ONLY a JSON object: {"action":"interrupt|queue|deliver|ignore","reason":"<short>"}',
  ].join("\n");
}

function parseInterruptionVerdict(raw: string): InterruptionDecision | null {
  const obj = parseJsonObjectResponse<{ action?: unknown; reason?: unknown }>(
    raw,
  );
  if (!obj) return null;
  const action =
    typeof obj.action === "string" ? obj.action.trim().toLowerCase() : "";
  if (
    action !== "interrupt" &&
    action !== "queue" &&
    action !== "deliver" &&
    action !== "ignore"
  ) {
    return null;
  }
  const detail =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim().slice(0, 160)
      : "verdict";
  return { action, reason: `model: ${detail}` };
}

/**
 * Model-backed interruption decision. Uses the pure regex {@link
 * decideInterruption} as a cheap pre-filter for the unambiguous cases (empty
 * text → ignore; an idle agent in a solo room → deliver), and for the
 * decision-critical cases (mid-turn, or a crowded room) asks a small model to
 * classify intent with full task context. Falls back to the regex decision on
 * any model error or unparseable verdict — so it never regresses the pure path.
 */
export async function decideInterruptionWithModel(
  runtime: IAgentRuntime,
  input: InterruptionInput,
): Promise<InterruptionDecision> {
  const baseline = decideInterruption(input);
  if (!input.text.trim()) return baseline;
  // Only a mid-turn agent (interrupt-vs-queue matters) or a crowded room
  // (directed-vs-ambient matters) warrants a model call. An idle agent in a
  // solo room simply receives the message.
  if (!input.sessionBusy && !input.multiParty) return baseline;
  try {
    const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: buildInterruptionClassifierPrompt(input),
      stopSequences: [],
    });
    const verdict = parseInterruptionVerdict(
      typeof raw === "string" ? raw : String(raw),
    );
    return verdict ?? baseline;
  } catch {
    // error-policy:J4 model unavailable/unparseable → deterministic regex baseline; never regresses pure path
    return baseline;
  }
}
