import { jwtVerify } from "jose";
import { getPublicRemoteJWKSet, type VerifiedOidcToken } from "./oidc";

function nonemptyClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// Public OAuth client IDs, keyed by the existing tenant app-client ID. This
// binds Google's signed azp to an approved Android package/signing certificate.
// The tenant_app_clients registry remains authoritative for app access.
const GOOGLE_NATIVE_CLIENT_IDS_ENV = "STEWARD_GOOGLE_NATIVE_CLIENT_IDS";

/**
 * Raised when {@link GOOGLE_NATIVE_CLIENT_IDS_ENV} is set but unusable.
 *
 * The mapping is operator configuration, so "absent" and "corrupt" are
 * different states: absent means this deployment has no Android Google client
 * bound (a supported state), corrupt means the deployment intends to accept
 * Android Google sign-ins but the value cannot be read. Collapsing both to
 * `[]` made a misconfigured deployment look like an unsupported one —
 * `/providers` reported `googleNative: false` and the native route answered
 * `503 "Native Google sign-in is not configured for this app"`, so the real
 * cause (a typo in the JSON) never surfaced anywhere.
 */
export class GoogleNativeClientConfigError extends Error {
  constructor(detail: string) {
    super(`${GOOGLE_NATIVE_CLIENT_IDS_ENV} is not usable: ${detail}`);
    this.name = "GoogleNativeClientConfigError";
  }
}

export function googleNativeClientIds(clientId: string): string[] {
  const raw = process.env[GOOGLE_NATIVE_CLIENT_IDS_ENV];
  // Unset/blank is a legitimate "no Android Google client bound".
  if (!raw?.trim()) return [];

  let configured: unknown;
  try {
    configured = JSON.parse(raw);
  } catch (error) {
    throw new GoogleNativeClientConfigError(
      `expected JSON, got ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !configured ||
    typeof configured !== "object" ||
    Array.isArray(configured)
  )
    throw new GoogleNativeClientConfigError(
      "expected a JSON object keyed by app client id",
    );

  const ids = (configured as Record<string, unknown>)[clientId];
  // Client id absent from a readable map: this app simply has no Android
  // client, which is the same legitimate empty state as an unset variable.
  if (ids === undefined) return [];
  if (!Array.isArray(ids))
    throw new GoogleNativeClientConfigError(
      `entry for client ${JSON.stringify(clientId)} must be an array of client ids`,
    );
  return ids.filter(
    (id): id is string =>
      typeof id === "string" &&
      /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(id),
  );
}

/** Verify an Android Google identity against server-owned OAuth clients. */
export async function verifyGoogleNativeIdToken(
  token: string,
  audience: string,
  androidClientIds: string[],
  nonce: string,
): Promise<VerifiedOidcToken & { email: string; emailVerified: true }> {
  const jwks = await getPublicRemoteJWKSet(
    "https://www.googleapis.com/oauth2/v3/certs",
    "google-native",
  );
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience,
    algorithms: ["RS256"],
    requiredClaims: [
      "sub",
      "exp",
      "iat",
      "nonce",
      "email",
      "email_verified",
      "azp",
    ],
    maxTokenAge: "5m",
  });
  if (
    payload.nonce !== nonce ||
    typeof payload.azp !== "string" ||
    !androidClientIds.includes(payload.azp) ||
    payload.email_verified !== true
  ) {
    throw new Error(
      "Google identity does not match the native sign-in challenge",
    );
  }
  const subject = nonemptyClaim(payload.sub);
  const email = nonemptyClaim(payload.email);
  if (!subject || !email) throw new Error("Google identity is incomplete");
  return {
    subject,
    email,
    emailVerified: true,
    name: nonemptyClaim(payload.name),
    picture: nonemptyClaim(payload.picture),
    claims: payload,
  };
}
