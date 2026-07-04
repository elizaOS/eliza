/**
 * Model action channel — the seam that lets the chat's single send funnel
 * (`sendActionMessage`, AppContext) reach the headless model-status conductor
 * WITHOUT the conductor having to be assembled before the AppContext value. It
 * carries two orthogonal signals:
 *
 * 1. Control taps on the in-chat model-status turn (Cancel / Switch to Eliza
 *    Cloud / Retry / Keep waiting). These are self-identifying via the reserved
 *    `__model__:` prefix (the CHOICE scope/id are dropped at the widget, so the
 *    VALUE carries the discriminator) and are consumed client-side by the
 *    conductor, never sent to the server. The prefix is reserved
 *    UNCONDITIONALLY: when the model becomes ready the handler is cleared and
 *    `isModelActionMessage` still recognises the value so a tap on a leftover
 *    status widget is dropped rather than sent as a literal `__model__:` chat
 *    message.
 *
 * 2. A "typed while the local model still blocks send" notification. When a real
 *    chat message is sent before the model is loaded, the funnel calls
 *    `notifyTypedWhileBlocked`; the conductor seeds an instant local
 *    acknowledgment so the message is visibly not lost (the real send still
 *    rides the existing server hold/503-retry). Returns whether the model is
 *    currently blocking so the funnel needs no direct model-status coupling.
 *
 * Mirrors `first-run-action-channel.ts`, but unlike first-run picks (choice-
 * driven, whole transcript locked) these signals coexist with free typing: the
 * model channel is orthogonal to onboarding, so it's consulted independent of
 * `firstRunComplete`.
 */

/** Reserved sentinel prefix for model-status control values. Never a real message. */
export const MODEL_ACTION_PREFIX = "__model__:";

type ModelActionHandler = (value: string) => boolean;
type TypedWhileBlockedObserver = () => boolean;

let actionHandler: ModelActionHandler | null = null;
let typedObserver: TypedWhileBlockedObserver | null = null;

/** The model-status conductor registers (and clears) its control-tap handler. */
export function setModelActionHandler(next: ModelActionHandler | null): void {
  actionHandler = next;
}

/**
 * The model-status conductor registers (and clears) its typed-while-blocked
 * observer. The observer seeds the acknowledgment turn (when blocked) and
 * returns whether the model is currently blocking send.
 */
export function setTypedWhileBlockedObserver(
  next: TypedWhileBlockedObserver | null,
): void {
  typedObserver = next;
}

/**
 * Returns true when the value was a model-status control consumed by the active
 * conductor (so the caller must NOT forward it to the server). Returns false
 * for every non-model value or when no conductor is active.
 */
export function tryHandleModelAction(value: string): boolean {
  if (!actionHandler) return false;
  if (!value.startsWith(MODEL_ACTION_PREFIX)) return false;
  return actionHandler(value);
}

/** True when a value carries the reserved model-control prefix. */
export function isModelActionMessage(value: string): boolean {
  return value.startsWith(MODEL_ACTION_PREFIX);
}

/**
 * Notify the conductor that a real chat message was sent. When the local model
 * currently blocks send the conductor seeds an acknowledgment turn and this
 * returns true; otherwise it returns false and the send proceeds untouched.
 */
export function notifyTypedWhileBlocked(): boolean {
  return typedObserver ? typedObserver() : false;
}
