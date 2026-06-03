/**
 * Shared helper — each unavailable service sweeper calls
 * `makeUnavailableSweep()` with the blocking task ID so the orchestrator
 * produces a clean yellow status instead of a silent no-op.
 */

export class UnavailableSweeperError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnavailableSweeperError";
  }
}

export function makeUnavailableSweep({ service, blockingTask, reason }) {
  return async function sweep({ logger }) {
    const msg = `${service} sweeper unavailable — ${reason} (blocking task: ${blockingTask}).`;
    logger.warn(msg);
    throw new UnavailableSweeperError(msg);
  };
}
