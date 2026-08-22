/** Strict, in-memory dispatch for target-side remote pairing deep links. */

const REMOTE_PAIRING_INTENT_EVENT = "eliza:remote-target-pairing";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RemoteTargetPairingIntent {
  sessionId: string;
  code: string;
  source: "qr";
}

let pendingIntent: RemoteTargetPairingIntent | null = null;

/**
 * Accepts only the canonical
 * `elizaos://remote/pair?session=<uuid>&code=<six-digits>` shape. Unknown,
 * duplicated, or extra fields fail closed so the URI cannot grow an implicit
 * credential or redirect channel.
 */
export function parseRemoteTargetPairingDeepLink(
  rawUrl: string,
  urlScheme = "elizaos",
): RemoteTargetPairingIntent | null {
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
    parsed.pathname !== "/pair" ||
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
export function dispatchRemoteTargetPairingIntent(
  intent: RemoteTargetPairingIntent,
): void {
  pendingIntent = intent;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(REMOTE_PAIRING_INTENT_EVENT, { detail: intent }),
    );
  }
}

/** Subscribes one consumer and atomically drains an intent queued before mount. */
export function subscribeRemoteTargetPairingIntents(
  listener: (intent: RemoteTargetPairingIntent) => void | Promise<void>,
): () => void {
  const claim = (intent: RemoteTargetPairingIntent): void => {
    if (pendingIntent !== intent) return;
    pendingIntent = null;
    void listener(intent);
  };
  const handle = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    claim(event.detail as RemoteTargetPairingIntent);
  };
  window.addEventListener(REMOTE_PAIRING_INTENT_EVENT, handle);
  if (pendingIntent) claim(pendingIntent);
  return () => window.removeEventListener(REMOTE_PAIRING_INTENT_EVENT, handle);
}

export const remoteTargetPairingIntentInternals = {
  clearPending(): void {
    pendingIntent = null;
  },
};
