/**
 * WebCrypto helpers shared by the OIDC provider modules: opaque credential
 * generation, sha256 digests, and the base64url encoding PKCE and JWTs use.
 *
 * Everything here runs on the global `crypto` object so the same code works in
 * workerd and on Node — no Node-only APIs, no third-party primitives.
 */

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/** 256 bits of CSPRNG output as lowercase hex — the shape of every opaque id here. */
export function createOpaqueHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `base64url(sha256(verifier))` — RFC 7636 S256. */
export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}
