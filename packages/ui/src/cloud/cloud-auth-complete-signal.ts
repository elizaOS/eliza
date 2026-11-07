/**
 * Cross-tab signal when a device-code / CLI Cloud login session finishes.
 *
 * The opener (local first-run or hosted shell) polls until authenticated; the
 * auth surface (popup or tab on elizacloud) may also complete via
 * `/auth/cli-login`. Orphaned intermediate tabs (e.g. Steward `/login` left
 * open after nested OAuth) do not share `window.opener`, so `postMessage` alone
 * cannot dismiss them. BroadcastChannel reaches every same-origin Cloud tab so
 * they can show a terminal "done" state instead of a live sign-in form.
 *
 * Localhost openers do not share origin with Cloud, so they still rely on
 * polling + `window.opener` postMessage; this channel is for Cloud-origin
 * surfaces talking to each other.
 */

export const CLOUD_AUTH_COMPLETE_MESSAGE_TYPE = "eliza-cloud-auth-complete";

export const CLOUD_AUTH_COMPLETE_CHANNEL = "eliza-cloud-auth-complete";
const CLOUD_AUTH_COMPLETE_STORAGE_PREFIX = "eliza-cloud-auth-complete:";
const CLOUD_AUTH_COMPLETE_TTL_MS = 10 * 60 * 1000;

export type CloudAuthCompleteMessage = {
  type: typeof CLOUD_AUTH_COMPLETE_MESSAGE_TYPE;
  sessionId: string;
};

export function isCloudAuthCompleteMessage(
  data: unknown,
  sessionId?: string,
): data is CloudAuthCompleteMessage {
  if (!data || typeof data !== "object") return false;
  const message = data as { type?: unknown; sessionId?: unknown };
  if (message.type !== CLOUD_AUTH_COMPLETE_MESSAGE_TYPE) return false;
  if (typeof message.sessionId !== "string" || !message.sessionId.trim()) {
    return false;
  }
  if (sessionId !== undefined && message.sessionId !== sessionId) return false;
  return true;
}

export function publishCloudAuthComplete(sessionId: string): void {
  const trimmed = sessionId.trim();
  if (!trimmed || typeof window === "undefined") return;
  const payload: CloudAuthCompleteMessage = {
    type: CLOUD_AUTH_COMPLETE_MESSAGE_TYPE,
    sessionId: trimmed,
  };
  try {
    window.localStorage.setItem(
      `${CLOUD_AUTH_COMPLETE_STORAGE_PREFIX}${trimmed}`,
      String(Date.now()),
    );
  } catch (error) {
    void error;
    // error-policy:J6 durable cross-tab replay is best-effort; live signaling remains available.
  }
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CLOUD_AUTH_COMPLETE_CHANNEL);
    channel.postMessage(payload);
    channel.close();
  } catch (error) {
    void error;
    // error-policy:J6 broadcast is best-effort; opener poll still completes login.
  }
}

/** True when this browser recently completed the exact CLI session. */
export function hasCloudAuthCompleted(sessionId: string): boolean {
  const trimmed = sessionId.trim();
  if (!trimmed || typeof window === "undefined") return false;
  const key = `${CLOUD_AUTH_COMPLETE_STORAGE_PREFIX}${trimmed}`;
  try {
    const completedAt = Number(window.localStorage.getItem(key));
    if (
      !Number.isFinite(completedAt) ||
      completedAt > Date.now() ||
      Date.now() - completedAt > CLOUD_AUTH_COMPLETE_TTL_MS
    ) {
      window.localStorage.removeItem(key);
      return false;
    }
    return true;
  } catch (error) {
    void error;
    // error-policy:J4 storage-denied browsers retain the live BroadcastChannel path.
    return false;
  }
}

/**
 * Subscribe to same-origin Cloud auth completion. Returns an unsubscribe fn.
 * No-ops when BroadcastChannel is unavailable (SSR / old engines).
 */
export function subscribeCloudAuthComplete(
  onComplete: (message: CloudAuthCompleteMessage) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return () => {};
  }
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CLOUD_AUTH_COMPLETE_CHANNEL);
  } catch (error) {
    void error;
    return () => {};
  }
  const handler = (event: MessageEvent) => {
    if (!isCloudAuthCompleteMessage(event.data)) return;
    onComplete(event.data);
  };
  channel.addEventListener("message", handler);
  return () => {
    try {
      channel.removeEventListener("message", handler);
      channel.close();
    } catch (error) {
      void error;
      // error-policy:J6 teardown only.
    }
  };
}

/**
 * True when this browsing context is already the device-code auth surface
 * (named popup or opened from the app). Nested OAuth must stay same-tab so we
 * do not leave the Steward sign-in form stranded in a sibling tab.
 *
 * `popupName` defaults to the Cloud login popup name (`eliza-cloud-auth`);
 * callers may pass {@link CLOUD_LOGIN_POPUP_NAME} explicitly to avoid a
 * packages-layer import cycle.
 */
export function isCloudAuthHandoffSurface(
  popupName = "eliza-cloud-auth",
): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.name === popupName) return true;
  } catch (error) {
    void error;
  }
  try {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed) return true;
  } catch (error) {
    void error;
  }
  return false;
}
