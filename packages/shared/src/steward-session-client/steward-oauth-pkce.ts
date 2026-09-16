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
import {
  getStewardTabSessionAuthorityCoordinator,
  StewardSessionAuthorityError,
  type StewardSessionAuthoritySnapshot,
} from "./tab-session-authority.js";

export type StewardOAuthProvider =
  | "google"
  | "discord"
  | "github"
  | "twitter"
  | "apple";

const STEWARD_PKCE_VERIFIER_STORAGE_KEY = "steward.oauth.pkce.verifier";
const STEWARD_PKCE_VERIFIER_TTL_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 48;
const OAUTH_STATE_BYTES = 32;

type StoredPkceVerifier = {
  verifier: string;
  /** OAuth anti-CSRF state sent at /authorize; absent only in legacy blobs. */
  state?: string;
  expiresAt: number;
  authority?: StewardOAuthAuthorityBinding;
  returnTo?: string;
};

/** Original session identity without persisting another copy of its bearer. */
export interface StewardOAuthAuthorityBinding {
  generation: string;
  scope: string | null;
  tokenFingerprint: string | null;
}

export async function createStewardOAuthAuthorityBinding(
  snapshot: StewardSessionAuthoritySnapshot,
): Promise<StewardOAuthAuthorityBinding> {
  return {
    generation: snapshot.generation,
    scope: snapshot.scope,
    tokenFingerprint:
      snapshot.token === null
        ? null
        : await createStewardPkceChallenge(snapshot.token),
  };
}

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
  authority?: StewardOAuthAuthorityBinding,
  returnTo?: string,
): boolean {
  if (typeof window === "undefined") return false;
  if (returnTo !== undefined && !isSameOriginReturnTo(returnTo)) return false;
  const stored = JSON.stringify({
    verifier,
    ...(state ? { state } : {}),
    ...(authority ? { authority } : {}),
    ...(returnTo !== undefined ? { returnTo } : {}),
    expiresAt: Date.now() + STEWARD_PKCE_VERIFIER_TTL_MS,
  } satisfies StoredPkceVerifier);
  let storedAnywhere = false;
  try {
    window.sessionStorage.setItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY, stored);
    storedAnywhere =
      window.sessionStorage.getItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY) ===
      stored;
  } catch {
    // error-policy:J4 a denied session store may use the acknowledged local fallback.
  }
  try {
    window.localStorage.setItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY, stored);
    storedAnywhere =
      window.localStorage.getItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY) ===
        stored || storedAnywhere;
  } catch {
    // error-policy:J4 fail visibly when neither store acknowledges this exact record.
  }
  return storedAnywhere;
}

/** Validate and consume one complete launch record before any callback exchange. */
export async function consumeStewardOAuthAttempt(
  state: string,
  signal?: AbortSignal,
): Promise<{
  codeVerifier: string;
  expected: StewardSessionAuthoritySnapshot;
  returnTo: string | null;
}> {
  const coordinator = getStewardTabSessionAuthorityCoordinator();
  const expected = coordinator.readSnapshot();
  return coordinator.runExclusive({
    kind: "callback-restore",
    expectedToken: expected.token,
    expectedGeneration: expected.generation,
    expectedScope: expected.scope,
    signal,
    work: async (authority) => {
      const sources = [() => window.sessionStorage, () => window.localStorage];
      const records = sources.map(readStoredPkceRecord);
      if (!records.some(Boolean)) {
        throw new Error(
          "This sign-in was started in another tab or has expired. Please start sign-in again.",
        );
      }
      const record = records.find((candidate) => candidate?.state === state);
      if (!record?.state || record.state !== state || !record.authority) {
        throw new Error(
          "This sign-in link is invalid or has expired. Please start sign-in again.",
        );
      }
      const binding = await createStewardOAuthAuthorityBinding(expected);
      authority.revalidate();
      if (
        binding.generation !== record.authority.generation ||
        binding.scope !== record.authority.scope ||
        binding.tokenFingerprint !== record.authority.tokenFingerprint
      ) {
        throw new StewardSessionAuthorityError(
          "The original OAuth session authority is no longer current.",
          "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
        );
      }
      let consumed = false;
      // Remove only identical copies of THIS record. A later launch in another
      // tab may have replaced the local fallback while this tab was away.
      for (const getStorage of sources) {
        const current = readStoredPkceRecord(getStorage);
        if (!current || JSON.stringify(current) !== JSON.stringify(record))
          continue;
        try {
          const storage = getStorage();
          storage.removeItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY);
          if (storage.getItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY) !== null) {
            throw new Error(
              "OAuth launch record removal was not acknowledged.",
            );
          }
          consumed = true;
        } catch (cause) {
          // error-policy:J2 callback dispatch requires acknowledged one-time consumption.
          throw new StewardSessionAuthorityError(
            "Could not consume the OAuth launch record.",
            "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
            { cause },
          );
        }
      }
      if (!consumed) {
        throw new StewardSessionAuthorityError(
          "The OAuth launch was replaced before callback consumption.",
          "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
        );
      }
      return {
        codeVerifier: record.verifier,
        expected,
        returnTo: record.returnTo ?? null,
      };
    },
  });
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
        parsed.verifier.length > 0 &&
        typeof parsed.expiresAt === "number" &&
        Number.isFinite(parsed.expiresAt) &&
        parsed.expiresAt >= Date.now()
      ) {
        if (
          parsed.returnTo !== undefined &&
          !isSameOriginReturnTo(parsed.returnTo)
        )
          return null;
        return {
          verifier: parsed.verifier,
          ...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
          expiresAt: parsed.expiresAt,
          ...(parsed.returnTo !== undefined
            ? { returnTo: parsed.returnTo }
            : {}),
          ...(isOAuthAuthorityBinding(parsed.authority)
            ? { authority: parsed.authority }
            : {}),
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

function isSameOriginReturnTo(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\\")
  )
    return false;
  try {
    const base = new URL("https://eliza-login.invalid/");
    return new URL(value, base).origin === base.origin;
  } catch {
    // error-policy:J3 malformed navigation input invalidates the complete launch record.
    return false;
  }
}

function isOAuthAuthorityBinding(
  value: unknown,
): value is StewardOAuthAuthorityBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<StewardOAuthAuthorityBinding>;
  return (
    typeof binding.generation === "string" &&
    binding.generation.length > 0 &&
    (binding.scope === null || typeof binding.scope === "string") &&
    (binding.tokenFingerprint === null ||
      (typeof binding.tokenFingerprint === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(binding.tokenFingerprint)))
  );
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
