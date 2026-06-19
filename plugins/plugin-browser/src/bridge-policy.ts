export const MAX_BROWSER_FOCUS_WINDOW_MS = 2 * 60 * 1000;
export const DEFAULT_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS =
  30 * 24 * 60 * 60 * 1000;

type BrowserBridgeCompanionPairingTokenEnv = {
  readonly [key: string]: string | undefined;
};

export function resolveBrowserBridgeCompanionPairingTokenTtlMs(
  env: BrowserBridgeCompanionPairingTokenEnv = process.env,
): number {
  const raw =
    env.BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS ??
    env.ELIZA_BROWSER_BRIDGE_COMPANION_TOKEN_TTL_MS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.trunc(parsed);
    }
  }
  return DEFAULT_BROWSER_COMPANION_PAIRING_TOKEN_TTL_MS;
}

export function resolveBrowserBridgeCompanionPairingTokenExpiresAt(
  nowMs = Date.now(),
  env?: Parameters<typeof resolveBrowserBridgeCompanionPairingTokenTtlMs>[0],
): string {
  return new Date(
    nowMs + resolveBrowserBridgeCompanionPairingTokenTtlMs(env),
  ).toISOString();
}

export function browserBridgeDomainFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const hostname = parsed.hostname.trim().toLowerCase().replace(/\.+$/, "");
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}
