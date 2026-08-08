/**
 * Short-lived HMAC proofs for OAuth success redirects.
 *
 * The browser landing page cannot inherit API-key Authorization headers, so
 * the OAuth callback mints a signed proof the public success page can verify
 * without an unrelated session. Proofs expire quickly and are not reusable as
 * long-lived credentials.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
import { getAllProviderIds } from "./provider-registry";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Reject absurd query-string proofs before HMAC work (payload.sig base64url). */
const MAX_PROOF_CHARS = 2_048;

/** Connector-native providers that emit `*_connected` but are outside OAUTH_PROVIDERS. */
const EXTRA_CONNECTED_MARKERS = new Set(["discord"]);

/** Own-property provider ids only — never Object.prototype names via `in`. */
const KNOWN_OAUTH_PROVIDER_IDS = new Set(
  getAllProviderIds().map((id) => id.toLowerCase()),
);

/** Reserved OAuth success query keys rewritten by callbacks. */
const OAUTH_SUCCESS_RESERVED_PARAMS = new Set([
  "proof",
  "platform",
  "connection_id",
]);

/**
 * True for known OAuth provider completion markers (`github_connected`, …).
 * Caller-owned keys like `socket_connected` / `constructor_connected` must not match.
 */
export function isOAuthSuccessConnectedParam(key: string): boolean {
  if (!key.endsWith("_connected")) return false;
  const platform = key.slice(0, -"_connected".length).toLowerCase();
  if (!platform) return false;
  return (
    KNOWN_OAUTH_PROVIDER_IDS.has(platform) ||
    EXTRA_CONNECTED_MARKERS.has(platform)
  );
}

/**
 * Whether this redirect targets the public `/auth/success` landing page that
 * consumes HMAC proofs. Dashboard and other callback consumers must not receive
 * transferable proof tokens in the URL.
 */
export function isOAuthSuccessLandingPath(pathname: string): boolean {
  // Exact path only — never a suffix match. `/foo/auth/success` is not the
  // public landing page and must not receive transferable HMAC proofs.
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized === "/auth/success";
}

/**
 * Drop only reserved OAuth success markers from a redirect URL before writing
 * a fresh completion, preserving unrelated caller query state.
 */
export function clearOAuthSuccessParams(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (
      OAUTH_SUCCESS_RESERVED_PARAMS.has(key) ||
      isOAuthSuccessConnectedParam(key)
    ) {
      url.searchParams.delete(key);
    }
  }
}

export interface OAuthSuccessProofPayload {
  platform: string;
  connectionId: string | null;
  exp: number;
  nonce: string;
}

function resolveProofSecret(): string | null {
  const env = getCloudAwareEnv();
  // Prefer a dedicated secret; fall back to already-provisioned Worker secrets
  // so production mints proofs without a new binding cutover.
  const secret =
    env.OAUTH_SUCCESS_PROOF_SECRET?.trim() ||
    env.STEWARD_SESSION_SECRET?.trim() ||
    env.STEWARD_JWT_SECRET?.trim() ||
    env.NEXTAUTH_SECRET?.trim() ||
    env.SESSION_SECRET?.trim() ||
    env.AUTH_SECRET?.trim() ||
    "";
  return secret.length >= 16 ? secret : null;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function sign(secret: string, payloadB64: string): string {
  return b64url(createHmac("sha256", secret).update(payloadB64).digest());
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Mint a proof for a completed OAuth callback. Returns null when no signing
 * secret is configured (callers should still redirect; the success page falls
 * back to session ownership checks).
 */
export function mintOAuthSuccessProof(args: {
  platform: string;
  connectionId?: string | null;
  ttlMs?: number;
}): string | null {
  const secret = resolveProofSecret();
  if (!secret) return null;
  const platform = args.platform.trim().toLowerCase();
  if (!platform) return null;
  const connectionId =
    typeof args.connectionId === "string" && args.connectionId.trim()
      ? args.connectionId.trim()
      : null;
  const payload: OAuthSuccessProofPayload = {
    platform,
    connectionId,
    exp: Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS),
    nonce: randomBytes(12).toString("hex"),
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const signature = sign(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

export type VerifyOAuthSuccessProofResult =
  | { ok: true; payload: OAuthSuccessProofPayload }
  | { ok: false; reason: "missing_secret" | "malformed" | "bad_signature" | "expired" };

/**
 * Verify a proof minted by {@link mintOAuthSuccessProof}.
 */
export function verifyOAuthSuccessProof(
  proof: string | null | undefined,
): VerifyOAuthSuccessProofResult {
  const secret = resolveProofSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (typeof proof !== "string" || !proof.trim()) {
    return { ok: false, reason: "malformed" };
  }
  const trimmed = proof.trim();
  if (trimmed.length > MAX_PROOF_CHARS) {
    return { ok: false, reason: "malformed" };
  }
  const parts = trimmed.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return { ok: false, reason: "malformed" };
  const expected = sign(secret, payloadB64);
  if (!safeEqual(expected, signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  try {
    const raw = JSON.parse(
      b64urlDecode(payloadB64).toString("utf8"),
    ) as Partial<OAuthSuccessProofPayload>;
    if (
      typeof raw.platform !== "string" ||
      !raw.platform.trim() ||
      typeof raw.exp !== "number" ||
      !Number.isFinite(raw.exp) ||
      typeof raw.nonce !== "string" ||
      !raw.nonce.trim()
    ) {
      return { ok: false, reason: "malformed" };
    }
    if (raw.exp < Date.now()) return { ok: false, reason: "expired" };
    const connectionId =
      typeof raw.connectionId === "string" && raw.connectionId.trim()
        ? raw.connectionId.trim()
        : null;
    return {
      ok: true,
      payload: {
        platform: raw.platform.trim().toLowerCase(),
        connectionId,
        exp: raw.exp,
        nonce: raw.nonce,
      },
    };
  } catch {
    // error-policy:J3 malformed proof payload is an explicit invalid result.
    return { ok: false, reason: "malformed" };
  }
}
