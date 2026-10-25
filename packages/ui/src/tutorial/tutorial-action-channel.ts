/**
 * Tutorial action channel — the seam that lets the chat's single send funnel
 * (`sendActionMessage`, AppContext) short-circuit tutorial-scoped choice picks
 * and the explicit "start/stop/restart tutorial" chat commands to the headless
 * tutorial conductor, mirroring `first-run-action-channel.ts`. A tutorial
 * choice value is self-identifying via the reserved `__tutorial__:` prefix
 * (the CHOICE scope/id are dropped at the widget, so the VALUE carries the
 * discriminator).
 *
 * The prefix is reserved UNCONDITIONALLY: a tap on a leftover tutorial widget
 * in an old transcript is consumed here even when no conductor is registered —
 * it never becomes a literal `__tutorial__:` chat message to the agent. Free
 * text is only intercepted when it exactly matches one of the three tutorial
 * commands (see {@link matchTutorialCommand}); everything else flows to the
 * real send untouched.
 */

/** Reserved sentinel prefix for tutorial choice values. Never a real message. */
export const TUTORIAL_ACTION_PREFIX = "__tutorial__:";

export type TutorialActionVerb = "next" | "stop" | "restart";
export type TutorialCommand = "start" | "stop" | "restart";

export interface TutorialAction {
  verb: TutorialActionVerb;
  /** The step the widget belongs to — guards stale taps on old widgets. */
  stepId: string;
}

/** Compose a choice value: `__tutorial__:<verb>:<stepId>`. */
export function buildTutorialActionValue(
  verb: TutorialActionVerb,
  stepId: string,
): string {
  return `${TUTORIAL_ACTION_PREFIX}${verb}:${stepId}`;
}

/** Parse a reserved value back into a verb + step id; null for garbage. */
export function parseTutorialAction(value: string): TutorialAction | null {
  if (!value.startsWith(TUTORIAL_ACTION_PREFIX)) return null;
  const suffix = value.slice(TUTORIAL_ACTION_PREFIX.length);
  const separator = suffix.indexOf(":");
  if (separator <= 0) return null;
  const verb = suffix.slice(0, separator);
  const stepId = suffix.slice(separator + 1);
  if (verb !== "next" && verb !== "stop" && verb !== "restart") return null;
  if (!stepId) return null;
  return { verb, stepId };
}

/**
 * Match the explicit tutorial chat commands — "start tutorial",
 * "stop tutorial", "restart tutorial" (case-insensitive, optional "the",
 * optional trailing punctuation). Deliberately exact-ish: a sentence that
 * merely mentions the tutorial ("how do I stop the tutorial from talking?")
 * must reach the agent as normal chat, so nothing beyond the bare command
 * matches.
 */
export function matchTutorialCommand(text: string): TutorialCommand | null {
  const m = text
    .trim()
    .match(/^(start|stop|restart)(?:\s+the)?\s+tutorial[.!]?$/i);
  if (!m) return null;
  return m[1].toLowerCase() as TutorialCommand;
}

type TutorialActionHandler = (action: TutorialAction) => void;
type TutorialTextHandler = (text: string, command: TutorialCommand) => boolean;

let actionHandler: TutorialActionHandler | null = null;
let textHandler: TutorialTextHandler | null = null;

/** The conductor registers (and on unmount clears) its action handler. */
export function setTutorialActionHandler(
  next: TutorialActionHandler | null,
): void {
  actionHandler = next;
}

/**
 * The conductor registers (and on unmount clears) its command handler: the
 * seam that lets "start/stop/restart tutorial" typed in the composer drive the
 * tour without the text ever reaching the server.
 */
export function setTutorialTextHandler(next: TutorialTextHandler | null): void {
  textHandler = next;
}

/**
 * Consume a reserved `__tutorial__:` choice value: dispatch it to the active
 * conductor (if any) and report that the value was handled so the caller must
 * NOT forward it to the server. Returns false only for non-tutorial values.
 */
export function tryHandleTutorialAction(value: string): boolean {
  if (!value.startsWith(TUTORIAL_ACTION_PREFIX)) return false;
  const action = parseTutorialAction(value);
  if (action) actionHandler?.(action);
  return true;
}

/**
 * Offer composer free text to the tutorial conductor. Returns true only when
 * the text is one of the explicit tutorial commands AND the conductor consumed
 * it (e.g. "stop tutorial" while no tour is running falls through to normal
 * chat). The caller must not forward consumed text to the server.
 */
export function tryHandleTutorialText(text: string): boolean {
  if (!textHandler) return false;
  const command = matchTutorialCommand(text);
  if (!command) return false;
  return textHandler(text, command);
}
