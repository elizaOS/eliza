/**
 * Timed wait for the Matrix client's first PREPARED sync.
 *
 * The listener is always removed when the wait settles so failed startup does
 * not leave lifecycle state attached to a client that will be stopped.
 */

import { MatrixSyncTimeoutError } from "./types.js";

/** Default wall-clock budget for the first PREPARED after startClient. */
export const MATRIX_INITIAL_SYNC_TIMEOUT_MS = 30_000;

export interface MatrixSyncEmitter {
  on(event: string, listener: (syncState: string) => void): void;
  removeListener(event: string, listener: (syncState: string) => void): void;
}

/**
 * Resolve when `syncEvent` reports PREPARED; reject with
 * {@link MatrixSyncTimeoutError} if the budget elapses first.
 */
export function waitForMatrixPrepared(
  client: MatrixSyncEmitter,
  syncEvent: string,
  timeoutMs: number = MATRIX_INITIAL_SYNC_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener(syncEvent, listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = (syncState: string) => {
      if (syncState === "PREPARED") finish();
    };
    const timer = setTimeout(() => {
      finish(new MatrixSyncTimeoutError(timeoutMs));
    }, timeoutMs);
    client.on(syncEvent, listener);
  });
}
