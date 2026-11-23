/**
 * How long a planner-less (deterministic) tool call may run before its
 * eligible Stage-1 acknowledgement is shown. Most deterministic calls (open a
 * view, read a named note) settle in ~0.1 s, where an acknowledgement is
 * noise; slow reads (calendar, 4-7 s on a phone) otherwise show nothing.
 */
export const DETERMINISTIC_TOOL_ACKNOWLEDGMENT_DELAY_MS = 400;

export interface DelayedAcknowledgment {
  /**
   * Ends the acknowledgement window: a pending acknowledgement is cancelled
   * and never sent; one already being delivered is awaited, so nothing the
   * caller delivers next can precede it. Idempotent.
   */
  settle(): Promise<void>;
}

/**
 * Sends `send` once after `delayMs` unless {@link DelayedAcknowledgment.settle}
 * runs first or `abortSignal` aborts. A delivery failure goes to `onError`;
 * transient progress cannot fail work that already ran.
 */
export function scheduleDelayedAcknowledgment({
  delayMs,
  send,
  abortSignal,
  onError,
}: {
  delayMs: number;
  send: () => void | Promise<void>;
  abortSignal?: AbortSignal;
  onError: (error: unknown) => void;
}): DelayedAcknowledgment {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    abortSignal?.removeEventListener("abort", cancel);
  };
  if (!abortSignal?.aborted) {
    abortSignal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      cancel();
      if (abortSignal?.aborted) return;
      // Started synchronously so a settle() after this tick always sees it.
      inFlight = (async () => send())().catch(onError);
    }, delayMs);
  }
  return {
    settle: async () => {
      cancel();
      await inFlight;
    },
  };
}
