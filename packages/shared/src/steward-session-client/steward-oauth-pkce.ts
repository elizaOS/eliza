/**
 * Steward OAuth PKCE helpers (RFC 7636).
 *
 * Steward's `/auth/oauth/:provider/authorize` requires a S256 `code_challenge`
 * when `response_type=code`. Mint a verifier/challenge pair, send the challenge
 * at /authorize, stash the verifier in browser storage, and replay it at
 * /exchange via {@link exchangeStewardCode}.
 *
 * A random OAuth `state` is minted and stashed alongside the verifier, sent
 * at /authorize, and required to match verbatim on the callback before the
 * exchange runs — without it, a harvested `?code=` link could log a victim
 * into the attacker's account (login CSRF).
 */

import { trimEndCharacters } from "../utils/string-boundaries.js";

export type StewardOAuthProvider = "google" | "discord" | "github" | "twitter";

const STEWARD_PKCE_VERIFIER_STORAGE_KEY = "steward.oauth.pkce.verifier";
const STEWARD_PKCE_VERIFIER_TTL_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 48;
const OAUTH_STATE_BYTES = 32;

type StoredPkceVerifier = {
  verifier: string;
  /** OAuth anti-CSRF state sent at /authorize; absent only in legacy blobs. */
  state?: string;
  expiresAt: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateStewardPkceVerifier(): string {
  const bytes = new Uint8Array(PKCE_VERIFIER_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function generateStewardOAuthState(): string {
  const bytes = new Uint8Array(OAUTH_STATE_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function createStewardPkceChallenge(
  verifier: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export interface StewardPkcePair {
  verifier: string;
  challenge: string;
}

export async function createStewardPkcePair(): Promise<StewardPkcePair> {
  const verifier = generateStewardPkceVerifier();
  const challenge = await createStewardPkceChallenge(verifier);
  return { verifier, challenge };
}

export function storeStewardPkceVerifier(
  verifier: string,
  state?: string,
): boolean {
  if (typeof window === "undefined") return false;
  const stored = JSON.stringify({
    verifier,
    ...(state ? { state } : {}),
    expiresAt: Date.now() + STEWARD_PKCE_VERIFIER_TTL_MS,
  } satisfies StoredPkceVerifier);
  let storedAnywhere = false;
  try {
    window.sessionStorage.setItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY, stored);
    storedAnywhere = true;
  } catch {
    // private mode / disabled storage
  }
  try {
    window.localStorage.setItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY, stored);
    storedAnywhere = true;
  } catch {
    // same as above
  }
  return storedAnywhere;
}

export function consumeStewardPkceVerifier(): string | null {
  if (typeof window === "undefined") return null;
  const sessionVerifier = consumeStoredPkceVerifier(
    () => window.sessionStorage,
  );
  const localVerifier = consumeStoredPkceVerifier(() => window.localStorage);
  return sessionVerifier ?? localVerifier;
}

/**
 * Non-consuming read of the OAuth state stashed beside the PKCE verifier.
 * The callback compares it against the `?state=` echo BEFORE the verifier is
 * consumed; a legacy blob without state (pre-state rollout) reads as null,
 * which fails the callback's required exact match.
 */
export function peekStewardOAuthState(): string | null {
  if (typeof window === "undefined") return null;
  const sessionRecord = readStoredPkceRecord(() => window.sessionStorage);
  const localRecord = readStoredPkceRecord(() => window.localStorage);
  return sessionRecord?.state ?? localRecord?.state ?? null;
}

function consumeStoredPkceVerifier(getStorage: () => Storage): string | null {
  try {
    const storage = getStorage();
    const verifier = storage.getItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY);
    storage.removeItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY);
    return parseStoredPkceVerifier(verifier);
  } catch {
    // error-policy:J4 web storage unavailable -> no verifier
    return null;
  }
}

function readStoredPkceRecord(
  getStorage: () => Storage,
): StoredPkceVerifier | null {
  try {
    const storage = getStorage();
    const value = storage.getItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as Partial<StoredPkceVerifier>;
      if (
        typeof parsed.verifier === "string" &&
        typeof parsed.expiresAt === "number" &&
        parsed.expiresAt >= Date.now()
      ) {
        return {
          verifier: parsed.verifier,
          ...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
          expiresAt: parsed.expiresAt,
        };
      }
      return null;
    } catch {
      // Pre-JSON blobs stored the bare verifier string; they carry no state,
      // so the callback's required state match fails for them by design.
      return null;
    }
  } catch {
    // error-policy:J4 web storage unavailable -> no stored record
    return null;
  }
}

function parseStoredPkceVerifier(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredPkceVerifier>;
    if (
      typeof parsed.verifier === "string" &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt >= Date.now()
    ) {
      return parsed.verifier;
    }
    return null;
  } catch {
    return value;
  }
}

export function buildStewardOAuthAuthorizeUrl(
  provider: StewardOAuthProvider,
  redirectUri: string,
  options: {
    stewardApiUrl: string;
    stewardTenantId?: string;
    codeChallenge?: string;
    /**
     * Anti-CSRF state echoed by Steward on the callback. Always send it: the
     * login surface refuses callbacks whose `?state=` does not exactly match
     * the value stashed beside the PKCE verifier.
     */
    state?: string;
  },
): string {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    tenant_id: options.stewardTenantId ?? "elizacloud",
    response_type: "code",
  });
  if (options.codeChallenge) {
    params.set("code_challenge", options.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  if (options.state) {
    params.set("state", options.state);
  }
  const stewardApiUrl = trimEndCharacters(options.stewardApiUrl, "/");
  return `${stewardApiUrl}/auth/oauth/${provider}/authorize?${params.toString()}`;
}
