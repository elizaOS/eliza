/**
 * Creates and hashes high-entropy bearer credentials for enrolled remote
 * hosts. Only the SHA-256 digest is persisted; the plaintext token is returned
 * once at enrollment and cannot be reconstructed by Cloud.
 */

const HOST_TOKEN_PREFIX = "rhost_v1_";
const HOST_TOKEN_PATTERN = /^rhost_v1_[A-Za-z0-9_-]{43}$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Creates a 256-bit host bearer credential for one-time display. */
export function generateRemoteHostToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${HOST_TOKEN_PREFIX}${bytesToBase64Url(bytes)}`;
}

/** Returns the canonical digest stored by the remote-host repository. */
export async function hashRemoteHostToken(token: string): Promise<string> {
  if (!HOST_TOKEN_PATTERN.test(token)) {
    throw new TypeError("remote host token is malformed");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `sha256:${bytesToHex(digest)}`;
}
