/**
 * Step-named timeout guard for the pendant connect sequence.
 *
 * Web Bluetooth on macOS Chrome can hang *forever* on individual GATT
 * operations (notably `getPrimaryService` when service discovery races the
 * connect, and `startNotifications` when the peripheral wants bonding for the
 * CCCD write). A bare `await gatt.getPrimaryService(...)` therefore leaves the
 * UI stuck at "connecting" with no error and no recovery.
 *
 * `withStepTimeout` races each await against a wall-clock deadline and rejects
 * with a {@link PendantStepTimeoutError} whose message names the exact step, so
 * the UI can surface *where* it stalled and the connect flow can land in a real
 * error (or trigger a one-shot retry) instead of hanging.
 */

/** The ordered steps of the pendant connect sequence (also the UI trace labels). */
export type PendantConnectStep =
  | "idle"
  | "gatt-connect"
  | "audio-service"
  | "codec-read"
  | "decoder-init"
  | "audio-char"
  | "start-notifications"
  | "battery"
  | "done";

/** Human-readable hint shown when a given step times out. */
const STEP_TIMEOUT_HINT: Partial<Record<PendantConnectStep, string>> = {
  "gatt-connect": "timed out establishing the GATT link",
  "audio-service": "timed out discovering the audio service",
  "codec-read": "timed out reading the codec type",
  "decoder-init": "timed out initializing the audio decoder",
  "audio-char": "timed out finding the audio characteristic",
  "start-notifications":
    "timed out subscribing to audio notifications — the firmware may require pairing for notifications",
  battery: "timed out reading the battery service",
};

/** Default per-step timeout. macOS Chrome GATT ops normally resolve in <1s. */
export const DEFAULT_STEP_TIMEOUT_MS = 12_000;

/** Error thrown when a connect step exceeds its timeout. Carries the step name. */
export class PendantStepTimeoutError extends Error {
  readonly step: PendantConnectStep;
  constructor(step: PendantConnectStep, message?: string) {
    super(message ?? STEP_TIMEOUT_HINT[step] ?? `timed out at ${step}`);
    this.name = "PendantStepTimeoutError";
    this.step = step;
  }
}

/** True when an error is a step timeout (used to decide whether to retry). */
export function isStepTimeout(err: unknown): err is PendantStepTimeoutError {
  return err instanceof PendantStepTimeoutError;
}

/**
 * Race `promise` against a `timeoutMs` deadline.
 *
 * On timeout the returned promise rejects with a {@link PendantStepTimeoutError}
 * naming `step`. The underlying `promise` is NOT cancellable (Web Bluetooth has
 * no abort), so the caller must tear the GATT link down on timeout to abandon
 * the still-pending operation — `PendantConnection.connect()` does exactly that
 * in its catch/cleanup.
 *
 * A resolved/rejected `promise` always clears the timer so we never leak it.
 */
export function withStepTimeout<T>(
  step: PendantConnectStep,
  promise: PromiseLike<T>,
  timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new PendantStepTimeoutError(step));
    }, timeoutMs);
    // `unref` on Node keeps a stray timer from holding a test process open; it
    // is absent in browsers, hence the guard.
    (timer as { unref?: () => void }).unref?.();

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
