import { resolveBrowserStewardApiUrl } from "@elizaos/cloud-shared/lib/steward-url";

const DEFAULT_STEWARD_TENANT_ID =
  process.env.NEXT_PUBLIC_STEWARD_TENANT_ID || "elizacloud";

export type StewardOAuthProvider = "google" | "discord" | "github";

/**
 * Build the redirect_uri we hand to Steward. Kept as a single function so the
 * value we send at /authorize time exactly matches the value we send at
 * /exchange time — Steward rejects the exchange if they differ.
 */
export function buildStewardOAuthRedirectUri(
  origin: string,
  redirectSearch?: string,
): string {
  let normalizedSearch = redirectSearch ?? "";
  if (normalizedSearch && !normalizedSearch.startsWith("?")) {
    normalizedSearch = `?${normalizedSearch}`;
  }
  return `${origin}/login${normalizedSearch}`;
}

export function buildStewardOAuthAuthorizeUrl(
  provider: StewardOAuthProvider,
  origin: string,
  options?: {
    redirectSearch?: string;
    stewardApiUrl?: string;
    stewardTenantId?: string;
    /**
     * PKCE S256 challenge. Steward's `/auth/oauth/:provider/authorize` rejects
     * `response_type=code` without it (`code_challenge is required for
     * response_type=code`). Pair it with the verifier replayed at /exchange via
     * {@link createStewardPkcePair} + {@link storeStewardPkceVerifier}.
     */
    codeChallenge?: string;
  },
): string {
  const redirectUri = buildStewardOAuthRedirectUri(
    origin,
    options?.redirectSearch,
  );
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    tenant_id: options?.stewardTenantId ?? DEFAULT_STEWARD_TENANT_ID,
    // Opt into the nonce-exchange flow: Steward redirects back with
    // `?code=<nonce>` (no tokens in the URL) and we trade the code for
    // tokens server-side via /api/auth/steward-nonce-exchange.
    response_type: "code",
  });
  if (options?.codeChallenge) {
    params.set("code_challenge", options.codeChallenge);
    params.set("code_challenge_method", "S256");
  }

  const stewardApiUrl =
    options?.stewardApiUrl ?? resolveBrowserStewardApiUrl(origin);

  return `${stewardApiUrl}/auth/oauth/${provider}/authorize?${params.toString()}`;
}

// ─── PKCE (RFC 7636) ────────────────────────────────────────────────────────
// Steward hardened `/auth/oauth/:provider/authorize` to require a PKCE
// `code_challenge` (S256) for `response_type=code`. We mint a high-entropy
// verifier, send `base64url(sha256(verifier))` as the challenge at /authorize,
// stash the verifier in sessionStorage, and replay it at /exchange. Steward
// recomputes the challenge and rejects the exchange unless it matches what was
// bound at /authorize — binding the redirect to the browser that began it
// (RFC 7636 auth-code interception defense). Mirrors Steward's
// `pkceChallengeForVerifier` (packages/api/src/routes/auth.ts).

const STEWARD_PKCE_VERIFIER_STORAGE_KEY = "steward.oauth.pkce.verifier";
// 48 random bytes → 64 base64url chars, comfortably inside RFC 7636's 43–128.
const PKCE_VERIFIER_BYTES = 48;

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

export function storeStewardPkceVerifier(verifier: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY, verifier);
    return true;
  } catch {
    // sessionStorage can throw (private mode / storage disabled). Signal failure
    // so the caller fails fast upfront instead of redirecting into a guaranteed
    // post-OAuth verifier mismatch (Steward bound a challenge we can't answer).
    return false;
  }
}

export function consumeStewardPkceVerifier(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const verifier = window.sessionStorage.getItem(
      STEWARD_PKCE_VERIFIER_STORAGE_KEY,
    );
    if (verifier) {
      window.sessionStorage.removeItem(STEWARD_PKCE_VERIFIER_STORAGE_KEY);
    }
    return verifier;
  } catch {
    return null;
  }
}
