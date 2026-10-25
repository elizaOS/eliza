/**
 * base64url helpers for the Web Push crypto path.
 *
 * All Web Push wire values (VAPID keys, JWT segments, ECDH public keys, salts)
 * are base64url per RFC 7515 / RFC 8291. These helpers are dependency-free and
 * run unmodified on Cloudflare Workers (no Node `Buffer`), so they can live in
 * the same module that WebCrypto-signs the VAPID JWT and encrypts the payload.
 */

/** Encode raw bytes to unpadded base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode unpadded (or padded) base64url to raw bytes. */
export function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized.length % 4 === 0 ? normalized : normalized + "=".repeat(4 - (normalized.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** UTF-8 encode a string to base64url (used for JWT header/payload segments). */
export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}
