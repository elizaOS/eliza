/**
 * Proactive-interaction decider (#8792).
 *
 * Consumes UI interaction events (view switches, slash commands, shortcuts) and
 * decides whether to surface a single scoped, helpful offer through either the
 * existing `routeAutonomyTextToUser` → `proactive-message` pipeline with
 * `source: "proactive-interaction"` or the low-priority notification rail.
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
  type ShortcutFiredPayload,
  type SlashCommandInvokedPayload,
  type ViewSwitchedPayload,
} from "@elizaos/core";
import { renderViewLiveStateForJudge } from "../providers/page-scoped-live-state.ts";
import {
  type ProactiveInteractionGate,
  resolveProactiveGateConfig,
} from "./proactive-interaction-gate.ts";

/** Source tag for proactive comments driven by UI interactions. */
export const PROACTIVE_INTERACTION_SOURCE = "proactive-interaction";

/** Any interaction the decider reacts to (#8792). */
export type InteractionPayload =
  | ViewSwitchedPayload
  | SlashCommandInvokedPayload
  | ShortcutFiredPayload;

/**
 * Runtime setting key for the user-facing "Proactive suggestions" control
 * (off/subtle/chatty). Read via `runtime.getSetting`, it takes precedence over
 * the `ELIZA_PROACTIVE_INTERACTIONS` env default inside the gate resolver.
 */
export const PROACTIVE_CHATTINESS_SETTING_KEY = "ELIZA_PROACTIVE_INTERACTIONS";

/** Where an admitted proactive offer should be delivered. */
export type ProactiveDelivery = "chat" | "notify";

/** A scoped offer from the judge, normalized before governance/admission. */
export interface ProactiveOffer {
  text: string;
  delivery: ProactiveDelivery;
  title?: string;
  deepLink?: string;
  groupKey?: string;
}

/** A model judge: given an interaction context, return an offer or null. */
export type ProactiveJudgeResult = string | ProactiveOffer | null;

export type ProactiveJudge = (
  payload: InteractionPayload,
) => Promise<ProactiveJudgeResult>;

export interface DecideProactiveInput {
  payload: InteractionPayload;
  gate: ProactiveInteractionGate;
  judge: ProactiveJudge;
  now: number;
}

/**
 * Control / dismiss / help shortcuts that must never trigger a proactive comment
 * (#8792). These are gestures, not intent: commenting on them is noise, and —
 * critically — the small-model judge runs BEFORE the governance gate, so letting
 * them reach the judge would spend a TEXT_SMALL call per keystroke. Denying them
 * here (a surface of `null`) skips the judge entirely. Navigation-bearing
 * shortcuts ("open X") report `VIEW_SWITCHED` through the navigate route instead,
 * so SHORTCUT_FIRED stays a small, high-signal channel for non-navigation
 * capability-invokes (e.g. opening the command palette).
 */
export const NON_PROACTIVE_SHORTCUT_IDS: ReadonlySet<string> = new Set([
  "close-modal",
  "send-message",
  "focus-composer",
  "pause-resume-agent",
  "restart-agent",
  "toggle-terminal",
  "show-keyboard-shortcuts",
]);

/**
 * The governance surface for an interaction, or `null` when policy says never
 * comment. Explicitly-typed slash commands return `null`: the user already
 * expressed intent and the command produced its own reply, so a proactive
 * comment would be double-talk (#8792 open question). Control/dismiss shortcuts
 * are denied (see {@link NON_PROACTIVE_SHORTCUT_IDS}). View switches key on the
 * view; remaining (intent-bearing) shortcuts key on the shortcut id.
 */
export function interactionSurface(payload: InteractionPayload): string | null {
  if ("command" in payload) return null; // explicit slash — stay silent
  if ("shortcutId" in payload) {
    if (NON_PROACTIVE_SHORTCUT_IDS.has(payload.shortcutId)) return null;
    return `shortcut:${payload.shortcutId}`;
  }
  if ("viewId" in payload && payload.viewId) return payload.viewId;
  return null;
}

export interface DecideProactiveResult {
  /** The comment to surface, or null when none should be sent. */
  text: string | null;
  /** Delivery rail for the admitted text. Null when no text is admitted. */
  delivery: ProactiveDelivery | null;
  /** Optional notification headline when delivery is notify. */
  title?: string;
  deepLink?: string;
  groupKey?: string;
  reason: string;
}

function normalizeProactiveOffer(
  result: ProactiveJudgeResult,
): ProactiveOffer | null {
  if (typeof result === "string") {
    const text = result.trim();
    if (!text || text.toLowerCase() === "none" || text === "null") return null;
    return { text, delivery: "chat" };
  }
  if (!result || typeof result !== "object") return null;
  const text = result.text.trim();
  if (!text || text.toLowerCase() === "none" || text === "null") return null;
  return {
    text,
    delivery: result.delivery === "notify" ? "notify" : "chat",
    title: result.title?.trim() || undefined,
    deepLink: result.deepLink?.trim() || undefined,
    groupKey: result.groupKey?.trim() || undefined,
  };
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
  const surface = interactionSurface(payload);
  if (!surface) {
    return {
      text: null,
      delivery: null,
      reason: "no surface (policy-silent)",
    };
  }

  if (payload.initiatedBy === "agent") {
    return {
      text: null,
      delivery: null,
      reason: "agent-initiated (already acknowledged)",
    };
  }

  if (!gate.isSettled(surface, now)) {
    return {
      text: null,
      delivery: null,
      reason: "debounce: surface not settled",
    };
  }

  const candidate = normalizeProactiveOffer(await judge(payload));
  if (!candidate) {
    return {
      text: null,
      delivery: null,
      reason: "judge: nothing helpful to offer",
    };
  }

  const admit = gate.tryAdmit({ surface, text: candidate.text, now });
  if (!admit.admitted) {
    return { text: null, delivery: null, reason: admit.reason };
  }
  return {
    text: candidate.text,
    delivery: candidate.delivery,
    title: candidate.title,
    deepLink: candidate.deepLink,
    groupKey: candidate.groupKey,
    reason: "admitted",
  };
}

const JUDGE_INSTRUCTION = [
  "The user just navigated in the app. Decide whether to greet them with ONE specific, helpful, anticipatory offer scoped to where they just landed.",
  "Rules:",
  "- When the view below has a DECLARED INTENT, produce a single short greeting that fulfills that intent and references the live view state provided (concrete counts, names, addresses, readiness). This is expected and wanted — return it with high confidence (>= 0.8). Do NOT stay silent just because it is a settings or config screen; the declared intent is your mandate.",
  "- When the view has NO declared intent, only offer something if it is clearly and specifically useful; otherwise stay silent (return null). Never emit a generic, label-only greeting.",
  "- One offer only. Ground every claim in the live state; never invent balances, counts, documents, tasks, or status. If the live state says a surface is unavailable, acknowledge that instead of fabricating a value.",
  '- Use delivery "chat" for a visible suggestion in the current view; use "notify" for useful but low-urgency offers that should land quietly outside chat.',
  'Respond as JSON: {"comment": <a short scoped greeting, or null>, "delivery": "chat" | "notify", "confidence": 0..1, "urgency": "low" | "medium" | "high", "title": <optional notification title>}.',
].join("\n");

/** Describe the interaction for the judge prompt, with live view state when available. */
function describeInteraction(
  payload: InteractionPayload,
  liveState?: string | null,
): string {
  if ("command" in payload) {
    return `The user just ran the /${payload.command} command.`;
  }
  if ("shortcutId" in payload) {
    return `The user just used the "${payload.shortcutId}" shortcut.`;
  }
  const where = payload.viewLabel ?? payload.viewId;
  const lines = [`The user just opened the "${where}" view.`];
  if (payload.viewPurpose) {
    lines.push(`Purpose: ${payload.viewPurpose}`);
  }
  lines.push(
    payload.anticipatoryIntent
      ? `Declared intent: ${payload.anticipatoryIntent}`
      : "Declared intent: none — this view has no declared anticipatory intent, so stay silent unless something is clearly useful.",
  );
  lines.push(
    liveState && liveState.trim().length > 0
      ? `Live view state:\n${liveState.trim()}`
      : "Live view state: none available for this view.",
  );
  return lines.join("\n");
}

/**
 * Build the small-model judge prompt for an interaction. `liveState` is the
 * rendered live-state brief for the target view (counts, balances, readiness);
 * it grounds an intent-bearing greeting so the model cannot fabricate values.
 */
export function buildProactiveJudgePrompt(
  payload: InteractionPayload,
  liveState?: string | null,
): string {
  return `${JUDGE_INSTRUCTION}\n${describeInteraction(payload, liveState)}`;
}

/** True when a view switch carries a declared anticipatory intent (#13587). */
function hasDeclaredIntent(payload: InteractionPayload): boolean {
  return (
    "viewId" in payload &&
    typeof payload.anticipatoryIntent === "string" &&
    payload.anticipatoryIntent.trim().length > 0
  );
}

function parseProactiveJudgeObject(
  raw: unknown,
): Record<string, unknown> | null {
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
  return obj as Record<string, unknown>;
}

function parseOptionalNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ParseJudgeOutputOptions {
  /**
   * When the target view declared an anticipatory intent, a scoped greeting is
   * the expected outcome — the confidence floor that suppresses low-signal
   * offers on generic views would wrongly veto it, so it is dropped here.
   * Suppression for no-intent views is unchanged.
   */
  hasDeclaredIntent?: boolean;
}

/** Confidence floor below which a no-intent offer is treated as noise. */
const NO_INTENT_CONFIDENCE_FLOOR = 0.65;

/** Parse the judge model output into a typed offer or null. */
export function parseProactiveJudgeDecisionOutput(
  raw: unknown,
  options?: ParseJudgeOutputOptions,
): ProactiveOffer | null {
  const obj = parseProactiveJudgeObject(raw);
  if (!obj) return null;
  const comment = obj.comment;
  if (typeof comment !== "string") return null;
  const trimmed = comment.trim();
  if (!trimmed || trimmed.toLowerCase() === "none" || trimmed === "null") {
    return null;
  }
  const confidence = parseOptionalNumber(obj.confidence);
  if (
    !options?.hasDeclaredIntent &&
    confidence !== null &&
    confidence < NO_INTENT_CONFIDENCE_FLOOR
  ) {
    return null;
  }
  const rawDelivery = obj.delivery ?? obj.channel ?? obj.route;
  const urgency =
    typeof obj.urgency === "string" ? obj.urgency.trim().toLowerCase() : "";
  const delivery =
    urgency === "low" ||
    rawDelivery === "notify" ||
    rawDelivery === "notification"
      ? "notify"
      : "chat";
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const deepLink = typeof obj.deepLink === "string" ? obj.deepLink.trim() : "";
  const groupKey = typeof obj.groupKey === "string" ? obj.groupKey.trim() : "";
  return {
    text: trimmed,
    delivery,
    title: title || undefined,
    deepLink: deepLink || undefined,
    groupKey: groupKey || undefined,
  };
}

/** Parse the judge model output into an offer string or null. */
export function parseProactiveJudgeOutput(raw: unknown): string | null {
  return parseProactiveJudgeDecisionOutput(raw)?.text ?? null;
}

export interface ProactiveDeciderWiring {
  /** Route an admitted comment to the user (proactive-message pipeline). */
  route: (text: string) => Promise<void>;
  /** Route an admitted low-urgency offer to the notification rail. */
  notify?: (offer: ProactiveOffer) => Promise<void>;
  /** Suppress comments while a foreground chat turn is already speaking/typing. */
  shouldSuppress?: () => boolean;
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

  // Resolve the live config PER interaction, not once at boot: the user-facing
  // "Proactive suggestions" control (off/subtle/chatty) writes
  // ELIZA_PROACTIVE_INTERACTIONS straight to process.env (config-routes), so
  // re-reading here lets the setting + kill-switch take effect immediately
  // without a runtime restart. The runtime setting overrides the env default.
  const resolveConfig = () => {
    const userSetting = runtime.getSetting(PROACTIVE_CHATTINESS_SETTING_KEY);
    return resolveProactiveGateConfig(
      process.env,
      typeof userSetting === "string" ? userSetting : undefined,
    );
  };

  const isSuppressed = (): boolean => {
    try {
      return wiring.shouldSuppress?.() === true;
    } catch (err) {
      logger.debug({ err }, "[proactive-interaction] suppression guard failed");
      return true;
    }
  };

  const judge: ProactiveJudge = async (payload) => {
    try {
      // Only pay for live-state rendering when the view declared an intent: that
      // is the sole path that produces a scoped greeting grounded in state. The
      // no-intent path is label-only and usually stays silent, so it stays cheap.
      const liveState =
        hasDeclaredIntent(payload) && "viewId" in payload && payload.viewId
          ? await renderViewLiveStateForJudge(runtime, payload.viewId)
          : null;
      const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: buildProactiveJudgePrompt(payload, liveState),
      });
      return parseProactiveJudgeDecisionOutput(raw, {
        hasDeclaredIntent: hasDeclaredIntent(payload),
      });
    } catch (err) {
      logger.debug({ err }, "[proactive-interaction] judge failed");
      return null;
    }
  };

  const handle = (payload: InteractionPayload) => {
    const surface = interactionSurface(payload);
    if (!surface) return; // policy-silent (e.g. explicit slash commands)
    if (isSuppressed()) return;

    const config = resolveConfig();
    wiring.gate.setConfig(config);
    if (config.chattiness === "off") {
      logger.debug("[proactive-interaction] suppressed: chattiness=off");
      return;
    }

    wiring.gate.noteSwitch(surface, clock());

    const run = async () => {
      try {
        if (isSuppressed()) return;
        const decision = await decideProactiveComment({
          payload,
          gate: wiring.gate,
          judge,
          now: clock(),
        });
        if (decision.text) {
          logger.info(
            { surface, delivery: decision.delivery },
            "[proactive-interaction] suggestion admitted",
          );
          if (isSuppressed()) return;
          if (decision.delivery === "notify") {
            if (wiring.notify) {
              await wiring.notify({
                text: decision.text,
                delivery: "notify",
                title: decision.title,
                deepLink: decision.deepLink,
                groupKey: decision.groupKey,
              });
            } else {
              logger.debug(
                "[proactive-interaction] notify delivery requested without notification route",
              );
            }
          } else {
            await wiring.route(decision.text);
          }
        } else {
          logger.debug(
            { surface, reason: decision.reason },
            "[proactive-interaction] suggestion suppressed",
          );
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
  };

  // All three interaction events flow through the same governed decider. Slash
  // commands are consumed but stay silent by policy (see interactionSurface).
  runtime.registerEvent(EventType.VIEW_SWITCHED, async (payload) => {
    handle(payload as ViewSwitchedPayload);
  });
  runtime.registerEvent(EventType.SHORTCUT_FIRED, async (payload) => {
    handle(payload as ShortcutFiredPayload);
  });
  runtime.registerEvent(EventType.SLASH_COMMAND_INVOKED, async (payload) => {
    handle(payload as SlashCommandInvokedPayload);
  });
}
