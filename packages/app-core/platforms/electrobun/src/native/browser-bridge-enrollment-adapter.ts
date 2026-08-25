/**
 * Exchanges an authenticated native enrollment request for the existing
 * owner-scoped browser companion credential through the local agent API.
 */

import type { DesktopSession, FetchLike } from "./auth-bridge";
import type { BrowserBridgeNativeBrowser } from "./browser-bridge-native-protocol";

export const BROWSER_BRIDGE_PAIR_ENDPOINT =
  "/api/browser-bridge/companions/pair";
export const BROWSER_BRIDGE_REVOKE_ENDPOINT = (companionId: string): string =>
  `/api/browser-bridge/companions/${encodeURIComponent(companionId)}/revoke`;
const DEFAULT_PAIR_TIMEOUT_MS = 10_000;

export class BrowserBridgePairingError extends Error {
  constructor(
    readonly code: "app_not_authenticated" | "revoked" | "broker_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "BrowserBridgePairingError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function requireLoopbackApiBase(apiBase: string): URL {
  const parsed = new URL(apiBase);
  if (
    parsed.protocol !== "http:" ||
    !isLoopbackHostname(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "browser companion owner actions require the loopback desktop API",
    );
  }
  return parsed;
}

function requireCurrentOwnerSession(ownerSession: DesktopSession): void {
  if (ownerSession.expiresAt <= Date.now()) {
    throw new Error("desktop owner session is expired");
  }
}

function ownerHeaders(ownerSession: DesktopSession): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: `eliza_session=${encodeURIComponent(ownerSession.sessionId)}`,
    "x-eliza-csrf": ownerSession.csrfToken,
  };
}

export interface BrowserBridgePairingResult {
  companion: {
    id: string;
    browser: string;
    profileId: string;
    profileLabel: string;
    label: string;
  };
  pairingToken: string;
  pairingTokenExpiresAt: string | null;
}

export interface BrowserBridgePairingPayload {
  browser: BrowserBridgeNativeBrowser;
  profileId: string;
  extensionVersion: string;
}

function validatePairingResult(value: unknown): BrowserBridgePairingResult {
  if (!value || typeof value !== "object")
    throw new Error("browser pairing response is invalid");
  const record = value as Record<string, unknown>;
  const companion = record.companion;
  if (!companion || typeof companion !== "object")
    throw new Error("browser pairing companion is invalid");
  const companionRecord = companion as Record<string, unknown>;
  const id = typeof companionRecord.id === "string" ? companionRecord.id : "";
  const browser =
    typeof companionRecord.browser === "string" ? companionRecord.browser : "";
  const profileId =
    typeof companionRecord.profileId === "string"
      ? companionRecord.profileId
      : "";
  const profileLabel =
    typeof companionRecord.profileLabel === "string"
      ? companionRecord.profileLabel
      : "";
  const label =
    typeof companionRecord.label === "string" ? companionRecord.label : "";
  const pairingToken =
    typeof record.pairingToken === "string" ? record.pairingToken : "";
  const pairingTokenExpiresAt =
    record.pairingTokenExpiresAt === null ||
    typeof record.pairingTokenExpiresAt === "string"
      ? record.pairingTokenExpiresAt
      : undefined;
  if (
    !id ||
    !browser ||
    !profileId ||
    !profileLabel ||
    !label ||
    !pairingToken ||
    pairingTokenExpiresAt === undefined
  ) {
    throw new Error("browser pairing response is incomplete");
  }
  return {
    companion: { id, browser, profileId, profileLabel, label },
    pairingToken,
    pairingTokenExpiresAt,
  };
}

export async function pairBrowserBridgeCompanionAsDesktopOwner(options: {
  apiBase: string;
  ownerSession: DesktopSession;
  payload: BrowserBridgePairingPayload;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<BrowserBridgePairingResult> {
  const apiBase = requireLoopbackApiBase(options.apiBase);
  requireCurrentOwnerSession(options.ownerSession);
  const abortController = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      new URL(BROWSER_BRIDGE_PAIR_ENDPOINT, apiBase),
      {
        method: "POST",
        headers: ownerHeaders(options.ownerSession),
        body: JSON.stringify({
          ...options.payload,
          pairingKind: "native_enrollment",
        }),
        signal: abortController.signal,
      },
    );
    if (!response.ok) {
      let responseCode: unknown;
      try {
        const body = (await response.json()) as unknown;
        responseCode =
          body && typeof body === "object"
            ? (body as Record<string, unknown>).code
            : null;
      } catch {
        // error-policy:J3 an untrusted non-JSON error body never becomes a valid pairing result.
        responseCode = null;
      }
      const code =
        responseCode === "revoked" || response.status === 410
          ? "revoked"
          : response.status === 401
            ? "app_not_authenticated"
            : "broker_unavailable";
      throw new BrowserBridgePairingError(
        code,
        `browser pairing API rejected enrollment with status ${response.status}`,
      );
    }
    return validatePairingResult(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function revokeBrowserBridgeCompanionAsDesktopOwner(options: {
  apiBase: string;
  ownerSession: DesktopSession;
  companionId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const apiBase = requireLoopbackApiBase(options.apiBase);
  requireCurrentOwnerSession(options.ownerSession);
  if (!options.companionId || options.companionId.length > 256) {
    throw new Error("browser companion ID is invalid");
  }
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetchImpl ?? fetch)(
      new URL(BROWSER_BRIDGE_REVOKE_ENDPOINT(options.companionId), apiBase),
      {
        method: "POST",
        headers: ownerHeaders(options.ownerSession),
        body: JSON.stringify({}),
        signal: abortController.signal,
      },
    );
    if (!response.ok) {
      throw new BrowserBridgePairingError(
        response.status === 401
          ? "app_not_authenticated"
          : "broker_unavailable",
        `browser companion revoke API rejected the owner request with status ${response.status}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}
