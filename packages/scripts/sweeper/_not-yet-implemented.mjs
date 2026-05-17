/**
 * Shared helper — each service sweeper calls `makeNotYetImplementedSweep()`
 * with the blocking task ID so the orchestrator produces a clean yellow
 * status instead of a silent no-op.
 */

export class NotYetImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotYetImplementedError";
  }
}

export function makeNotYetImplementedSweep({ service, blockingTask, reason }) {
  return async function sweep({ logger }) {
    const msg = `${service} sweeper not yet implemented — ${reason} (blocking task: ${blockingTask}).`;
    logger.warn(msg);
    throw new NotYetImplementedError(msg);
  };
}
