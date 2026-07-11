import type { LinkedAccountProviderId } from "@elizaos/shared";
import { shellLocalStorage } from "../../surface-realm-channel";

const PREFIX = "eliza.subscription-oauth.v1";
const MAX_AGE_MS = 20 * 60 * 1000;

export type SubscriptionOAuthMode = "localhost" | "device";
export type SubscriptionOAuthPhase = "waiting" | "need-code";

export interface PersistedSubscriptionOAuth {
  providerId: LinkedAccountProviderId;
  sessionId: string;
  mode: SubscriptionOAuthMode;
  phase: SubscriptionOAuthPhase;
  deviceCode?: string;
  startedAt: number;
}

function key(providerId: LinkedAccountProviderId): string {
  return `${PREFIX}:${providerId}`;
}

export function readSubscriptionOAuth(
  providerId: LinkedAccountProviderId,
): PersistedSubscriptionOAuth | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key(providerId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedSubscriptionOAuth>;
    const valid =
      value.providerId === providerId &&
      typeof value.sessionId === "string" &&
      (value.mode === "localhost" || value.mode === "device") &&
      (value.phase === "waiting" || value.phase === "need-code") &&
      typeof value.startedAt === "number" &&
      Date.now() - value.startedAt < MAX_AGE_MS;
    if (!valid) {
      shellLocalStorage.removeItem(key(providerId));
      return null;
    }
    return value as PersistedSubscriptionOAuth;
  } catch {
    return null;
  }
}

export function writeSubscriptionOAuth(
  value: PersistedSubscriptionOAuth,
): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.setItem(key(value.providerId), JSON.stringify(value));
  } catch {
    // In-memory flow remains usable when storage is unavailable.
  }
}

export function clearSubscriptionOAuth(
  providerId: LinkedAccountProviderId,
): void {
  if (typeof window === "undefined") return;
  try {
    shellLocalStorage.removeItem(key(providerId));
  } catch {
    // Nothing else to clear.
  }
}
