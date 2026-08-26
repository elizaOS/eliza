/** Strict, in-memory dispatch for controller-side remote pairing claims. */

const REMOTE_PAIRING_INTENT_EVENT = "eliza:remote-controller-pairing";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RemoteControllerPairingIntent {
  sessionId: string;
  code: string;
  source: "qr";
}

let pendingIntent: RemoteControllerPairingIntent | null = null;

/**
 * Accepts only the canonical
 * `elizaos://remote/control-claim?session=<uuid>&code=<six-digits>` shape.
 * The distinct path can never be mistaken for the retired target-consumes
 * deep link. Unknown,
 * duplicated, or extra fields fail closed so the URI cannot grow an implicit
 * credential or redirect channel.
 */
export function parseRemoteControllerPairingDeepLink(
  rawUrl: string,
  urlScheme = "elizaos",
): RemoteControllerPairingIntent | null {
  if (rawUrl.length === 0 || rawUrl.length > 2_048) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // error-policy:J3 OS-delivered deep-link bytes are untrusted input.
    return null;
  }
  if (
    parsed.protocol !== `${urlScheme.toLowerCase()}:` ||
    parsed.host !== "remote" ||
    parsed.pathname !== "/control-claim" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    return null;
  }
  const entries = [...parsed.searchParams.entries()];
  if (
    entries.length !== 2 ||
    parsed.searchParams.getAll("session").length !== 1 ||
    parsed.searchParams.getAll("code").length !== 1
  ) {
    return null;
  }
  const sessionId = parsed.searchParams.get("session") ?? "";
  const code = parsed.searchParams.get("code") ?? "";
  if (!UUID_PATTERN.test(sessionId) || !/^\d{6}$/.test(code)) return null;
  return { sessionId, code, source: "qr" };
}

/** Keeps at most one short-lived QR intent in renderer memory until Settings mounts. */
export function dispatchRemoteControllerPairingIntent(
  intent: RemoteControllerPairingIntent,
): void {
  pendingIntent = intent;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(REMOTE_PAIRING_INTENT_EVENT, { detail: intent }),
    );
  }
}

/** Subscribes one consumer and atomically drains an intent queued before mount. */
export function subscribeRemoteControllerPairingIntents(
  listener: (intent: RemoteControllerPairingIntent) => void | Promise<void>,
): () => void {
  const claim = (intent: RemoteControllerPairingIntent): void => {
    if (pendingIntent !== intent) return;
    pendingIntent = null;
    void listener(intent);
  };
  const handle = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    claim(event.detail as RemoteControllerPairingIntent);
  };
  window.addEventListener(REMOTE_PAIRING_INTENT_EVENT, handle);
  if (pendingIntent) claim(pendingIntent);
  return () => window.removeEventListener(REMOTE_PAIRING_INTENT_EVENT, handle);
}

export const remoteControllerPairingIntentInternals = {
  clearPending(): void {
    pendingIntent = null;
  },
};
