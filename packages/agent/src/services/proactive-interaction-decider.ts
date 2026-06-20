/**
 * Proactive-interaction decider (#8792).
 *
 * Consumes UI interaction events (view switches today; slash/shortcut wireable
 * the same way) and decides whether to surface a single scoped, helpful comment
 * through the existing `routeAutonomyTextToUser` → `proactive-message` pipeline
 * with `source: "proactive-interaction"`.
 *
 * Two layers, both testable in isolation:
 *  - {@link decideProactiveComment} — the pure policy + governance decision
 *    (injected judge / gate / clock), no runtime, no model, no network.
 *  - {@link registerProactiveInteractionDecider} — the thin runtime wiring that
 *    subscribes to the event bus, runs the small-model judge, and routes the
 *    admitted comment.
 */
import {
  EventType,
  type IAgentRuntime,
  logger,
  ModelType,
  type ViewSwitchedPayload,
} from "@elizaos/core";
import {
  type ProactiveInteractionGate,
  resolveProactiveGateConfig,
} from "./proactive-interaction-gate.ts";

/** Source tag for proactive comments driven by UI interactions. */
export const PROACTIVE_INTERACTION_SOURCE = "proactive-interaction";

/** A model judge: given a view-switch context, return an offer or null. */
export type ProactiveJudge = (
  payload: ViewSwitchedPayload,
) => Promise<string | null>;

export interface DecideProactiveInput {
  payload: ViewSwitchedPayload;
  gate: ProactiveInteractionGate;
  judge: ProactiveJudge;
  now: number;
}

export interface DecideProactiveResult {
  /** The comment to surface, or null when none should be sent. */
  text: string | null;
  reason: string;
}

/**
 * Decide whether to comment on a view switch. Policy + governance only:
 *  - Skip AGENT-initiated switches — the agent already acknowledged the move
 *    (#8788), so a second proactive comment would be double-talk.
 *  - Require the caller-recorded switch to have settled, then ask the judge for
 *    a scoped offer.
 *  - A null/empty judge result means "nothing helpful to say" → silence.
 *  - The governance gate (cooldowns / cap / dedup / debounce) makes the final
 *    call and records the emission.
 */
export async function decideProactiveComment(
  input: DecideProactiveInput,
): Promise<DecideProactiveResult> {
  const { payload, gate, judge, now } = input;
  const surface = payload.viewId;
  if (!surface) return { text: null, reason: "no surface" };

  if (payload.initiatedBy === "agent") {
    return { text: null, reason: "agent-initiated (already acknowledged)" };
  }

  if (!gate.isSettled(surface, now)) {
    return { text: null, reason: "debounce: surface not settled" };
  }

  const candidate = (await judge(payload))?.trim();
  if (!candidate) {
    return { text: null, reason: "judge: nothing helpful to offer" };
  }

  const admit = gate.tryAdmit({ surface, text: candidate, now });
  if (!admit.admitted) {
    return { text: null, reason: admit.reason };
  }
  return { text: candidate, reason: "admitted" };
}

const JUDGE_INSTRUCTION = [
  "The user just switched to an app view. Decide if there is ONE specific, helpful thing you can proactively offer about that view right now.",
  'Examples: switched to wallet → "Want me to pull your latest balances?"; opened task-coordinator → "Want me to summarize your open tasks?".',
  "Stay silent (return none) for ambiguous or low-value switches, settings/config screens, or anything where a comment would be noise.",
  'Respond as JSON: {"comment": <a short offer, or null>}.',
].join("\n");

/** Build the small-model judge prompt for a view switch. */
export function buildProactiveJudgePrompt(
  payload: ViewSwitchedPayload,
): string {
  const where = payload.viewLabel ?? payload.viewId;
  return `${JUDGE_INSTRUCTION}\nThe user just opened the ${where} view.`;
}

/** Parse the judge model output into an offer string or null. */
export function parseProactiveJudgeOutput(raw: unknown): string | null {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const comment = (obj as Record<string, unknown>).comment;
  if (typeof comment !== "string") return null;
  const trimmed = comment.trim();
  if (!trimmed || trimmed.toLowerCase() === "none" || trimmed === "null") {
    return null;
  }
  return trimmed;
}

export interface ProactiveDeciderWiring {
  /** Route an admitted comment to the user (proactive-message pipeline). */
  route: (text: string) => Promise<void>;
  gate: ProactiveInteractionGate;
  /** Override the clock (tests). */
  now?: () => number;
}

/**
 * Subscribe the decider to the runtime event bus. Each VIEW_SWITCHED runs the
 * small-model judge and, if the governance gate admits, routes the comment.
 * Fire-and-forget; failures degrade silently (a missed proactive comment must
 * never break the interaction).
 */
export function registerProactiveInteractionDecider(
  runtime: IAgentRuntime,
  wiring: ProactiveDeciderWiring,
): void {
  const clock = wiring.now ?? Date.now;
  const config = resolveProactiveGateConfig();
  wiring.gate.setConfig(config);
  if (config.chattiness === "off") {
    logger.debug("[proactive-interaction] disabled by config; not subscribing");
    return;
  }

  const judge: ProactiveJudge = async (payload) => {
    try {
      const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: buildProactiveJudgePrompt(payload),
      });
      return parseProactiveJudgeOutput(raw);
    } catch (err) {
      logger.debug({ err }, "[proactive-interaction] judge failed");
      return null;
    }
  };

  runtime.registerEvent(EventType.VIEW_SWITCHED, async (payload) => {
    const viewPayload = payload as ViewSwitchedPayload;
    const surface = viewPayload.viewId;
    if (!surface) return;

    wiring.gate.noteSwitch(surface, clock());

    const run = async () => {
      try {
        const decision = await decideProactiveComment({
          payload: viewPayload,
          gate: wiring.gate,
          judge,
          now: clock(),
        });
        if (decision.text) {
          await wiring.route(decision.text);
        }
      } catch (err) {
        logger.debug({ err }, "[proactive-interaction] decider failed");
      }
    };

    if (config.debounceMs > 0) {
      setTimeout(() => {
        void run();
      }, config.debounceMs);
    } else {
      void run();
    }
  });
}
