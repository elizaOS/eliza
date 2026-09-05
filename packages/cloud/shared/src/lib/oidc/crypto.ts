/**
 * WebCrypto helpers shared by the OIDC provider modules: opaque credential
 * generation, sha256 digests, and the base64url encoding PKCE and JWTs use.
 *
 * Everything here runs on the global `crypto` object so the same code works in
 * workerd and on Node — no Node-only APIs, no third-party primitives.
 */

import {
  bytesToBase64Url,
  bytesToHex,
  sha256Base64Url as digestBase64Url,
  sha256Hex as digestHex,
} from "../crypto/worker";

/** 256 bits of CSPRNG output as lowercase hex — the shape of every opaque id here. */
export function createOpaqueHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  return digestHex(input);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64Url(bytes);
}

/** `base64url(sha256(verifier))` — RFC 7636 S256. */
export async function sha256Base64Url(input: string): Promise<string> {
  return digestBase64Url(input);
}
