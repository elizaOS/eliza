/**
 * Bounds handoff steps and retry waits by the initiating caller's lifetime.
 * Aborting stops local continuation; it does not roll back a dispatched server
 * mutation, whose current state must be reviewed before another attempt.
 */
import { runAbortableRequest } from "../../api/abortable-request";

export const HANDOFF_CANCELLED_MESSAGE =
  "Dedicated setup was cancelled locally. Review its current state before continuing.";

export async function runHandoffStep<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const result = signal ? await runAbortableRequest(signal, run) : await run();
  signal?.throwIfAborted();
  return result;
}

export async function waitForHandoffRetry(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await runHandoffStep(
      signal,
      () =>
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
