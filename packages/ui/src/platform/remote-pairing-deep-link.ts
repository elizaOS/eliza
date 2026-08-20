/** In-memory handoff from an OS-delivered pairing QR link to Settings. */
export const REMOTE_PAIRING_DEEP_LINK_EVENT = "eliza:remote-pairing-code";

let pendingCode: string | null = null;

export function queueRemotePairingDeepLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "elizaos:" || parsed.hostname !== "pair")
    return false;
  const code = parsed.searchParams.get("code")?.replace(/\D/g, "") ?? "";
  if (!/^\d{6}$/.test(code)) return false;
  const session = parsed.searchParams.get("session");
  if (session && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(session)) return false;
  pendingCode = code;
  globalThis.dispatchEvent?.(
    new CustomEvent(REMOTE_PAIRING_DEEP_LINK_EVENT, { detail: { code } }),
  );
  return true;
}

/** Returns a pending one-time code once; it is never persisted to web storage. */
export function takePendingRemotePairingCode(): string | null {
  const code = pendingCode;
  pendingCode = null;
  return code;
}

/** Inspect the queued code without consuming it while Cloud auth is pending. */
export function peekPendingRemotePairingCode(): string | null {
  return pendingCode;
}

/**
 * Clear only the code that was successfully redeemed. A second QR arriving
 * while the first request is in flight must remain queued for its own redeem.
 */
export function clearPendingRemotePairingCode(code: string): boolean {
  if (pendingCode !== code) return false;
  pendingCode = null;
  return true;
}
