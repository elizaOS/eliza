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
}

// Explicit "stop what you're doing" intent.
const STOP_PATTERN =
  /\b(stop|cancel|abort|halt|never ?mind|forget it|that'?s enough|quit it|kill it)\b/i;

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
  if (STOP_PATTERN.test(text) && !additive) {
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
