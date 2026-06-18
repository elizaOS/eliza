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

// Explicit "stop what you're doing" intent — always interrupts.
const STOP_PATTERN =
  /\b(stop|cancel|abort|halt|never ?mind|forget it|hold on|hold up|wait stop|that'?s enough|quit it)\b/i;

// Course-correction intent — interrupts only when the agent is mid-turn and the
// message is plausibly aimed at it (an idle agent just receives it as the next
// instruction).
const REDIRECT_PATTERN =
  /\b(actually|instead|no,? do|don'?t|do not|scrap|undo|revert|change of plan|wrong|that'?s wrong|redirect)\b/i;

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

  // Explicit stop always interrupts, busy or not.
  if (STOP_PATTERN.test(text)) {
    return { action: "interrupt", reason: "explicit stop/cancel" };
  }

  if (!input.sessionBusy) {
    // Idle agent: an unaddressed ambient line in a crowded room is not for it.
    if (input.multiParty && !addressed) {
      return { action: "ignore", reason: "ambient chatter, agent idle" };
    }
    return { action: "deliver", reason: "agent idle" };
  }

  // Agent is mid-turn from here on — default is to NOT disrupt it.
  if (addressed && REDIRECT_PATTERN.test(text)) {
    return { action: "interrupt", reason: "addressed course-correction" };
  }
  if (input.multiParty && !addressed) {
    return { action: "ignore", reason: "ambient chatter during turn" };
  }
  return { action: "queue", reason: "relevant; deliver after current turn" };
}
