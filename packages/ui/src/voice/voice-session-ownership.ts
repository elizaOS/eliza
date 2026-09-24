/** Holds one realtime microphone session per origin, with synchronous same-realm exclusion when Web Locks are unavailable. */
export interface VoiceSessionLease {
  ready: Promise<void>;
  release(): Promise<void>;
}
let realmOwner: symbol | undefined;
const LOCK_NAME = "eliza-realtime-voice-session";

/** Claim immediately; browser contention rejects rather than queueing a future capture. */
export function claimVoiceSession(
  signal: AbortSignal,
  locks: LockManager | undefined = typeof window === "undefined"
    ? undefined
    : window.navigator.locks,
): VoiceSessionLease {
  if (realmOwner)
    throw new Error(
      "Voice is already active in another session or tab. Stop it there first.",
    );
  signal.throwIfAborted();
  const owner = Symbol();
  realmOwner = owner;
  let released = false;
  let lockRequest: Promise<void> | undefined;
  let granted = !locks;
  let rejectPending: ((error: Error) => void) | undefined;
  let unlock = () => {};
  const held = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const release = async () => {
    if (released) return lockRequest;
    released = true;
    if (realmOwner === owner) realmOwner = undefined;
    signal.removeEventListener("abort", cancelPending);
    unlock();
    await lockRequest;
  };
  const cancelPending = () => {
    if (!granted) {
      release();
      rejectPending?.(new DOMException("Voice start cancelled", "AbortError"));
    }
  };
  signal.addEventListener("abort", cancelPending, { once: true });
  const ready = locks
    ? new Promise<void>((resolve, reject) => {
        rejectPending = reject;
        lockRequest = Promise.resolve()
          .then(() =>
            locks.request(
              LOCK_NAME,
              { mode: "exclusive", ifAvailable: true },
              async (lock) => {
                if (released || signal.aborted) {
                  reject(
                    new DOMException("Voice start cancelled", "AbortError"),
                  );
                  return;
                }
                if (!lock) {
                  release();
                  reject(
                    new Error(
                      "Voice is already active in another tab. Stop it there first.",
                    ),
                  );
                  return;
                }
                granted = true;
                resolve();
                await held;
              },
            ),
          )
          .catch((error) => {
            // error-policy:J1 Surface lock-manager failure to the voice start boundary.
            release();
            reject(error);
          });
      })
    : Promise.resolve();
  return { ready, release };
}
