/**
 * PKCE primitives for the OAuth 2.0 flow: base64url encoding plus code-verifier,
 * code-challenge (S256), and state generation. Consumed by `oauth2-pkce.ts` when
 * building the authorization request and exchanging the code.
 */
import { createHash, randomBytes } from "node:crypto";

export function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function createCodeVerifier(byteLength = 32): string {
  // RFC 7636: code_verifier length 43-128 chars. 32 bytes => 43 chars in base64url.
  return base64UrlEncode(randomBytes(byteLength));
}

export function createCodeChallenge(verifier: string): string {
  const hash = createHash("sha256").update(verifier).digest();
  return base64UrlEncode(hash);
}

export function createState(byteLength = 16): string {
  return base64UrlEncode(randomBytes(byteLength));
}
