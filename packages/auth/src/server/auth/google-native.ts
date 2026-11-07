import { jwtVerify } from "jose";
import { getPublicRemoteJWKSet, type VerifiedOidcToken } from "./oidc";

function nonemptyClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// Public OAuth client IDs, keyed by the existing tenant app-client ID. This
// binds Google's signed azp to an approved Android package/signing certificate.
// The tenant_app_clients registry remains authoritative for app access.
export function googleNativeClientIds(clientId: string): string[] {
  try {
    const raw = process.env.STEWARD_GOOGLE_NATIVE_CLIENT_IDS;
    if (!raw) return [];
    const configured: unknown = JSON.parse(raw);
    if (
      !configured ||
      typeof configured !== "object" ||
      Array.isArray(configured)
    )
      return [];
    const ids = (configured as Record<string, unknown>)[clientId];
    return Array.isArray(ids)
      ? ids.filter(
          (id): id is string =>
            typeof id === "string" &&
            /^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(id),
        )
      : [];
  } catch {
    return [];
  }
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
