/**
 * Model action channel — the seam that lets the chat's single send funnel
 * short-circuit the in-chat model-status card's controls (cancel / switch to
 * cloud / retry / download) to the headless model-status conductor, mirroring
 * `first-run-action-channel.ts`. A control's value is self-identifying via the
 * reserved `__model__:` prefix (the CHOICE scope/id are dropped at the widget,
 * so the VALUE carries the discriminator).
 *
 * The prefix is reserved UNCONDITIONALLY: after the model is ready the handler
 * is cleared and `classifyModelActionMessage` still consumes the value — a tap
 * on a stale status-card control never becomes a chat send.
 */

/** Reserved sentinel prefix for model-status control values. Never a real message. */
export const MODEL_ACTION_PREFIX = "__model__:";

type ModelActionHandler = (value: string) => boolean;

let handler: ModelActionHandler | null = null;

/** The model-status conductor registers (and on teardown clears) its handler. */
export function setModelActionHandler(next: ModelActionHandler | null): void {
  handler = next;
}

/** True for any reserved `__model__:` control value. */
export function isModelActionValue(value: string): boolean {
  return value.startsWith(MODEL_ACTION_PREFIX);
}

/**
 * Consume a reserved `__model__:` control value: dispatch it to the active
 * conductor (if any) and report that the value was handled so the caller must
 * NOT forward it to the server. Returns false only for non-model values.
 */
export function tryHandleModelAction(value: string): boolean {
  if (!value.startsWith(MODEL_ACTION_PREFIX)) return false;
  handler?.(value);
  return true;
}
