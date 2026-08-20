/** One-time-returned high-entropy host bearer token hashing. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateRemoteHostToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `eliza_host_${base64Url(bytes)}`;
}

export async function hashRemoteHostToken(token: string): Promise<string> {
  const trimmed = token.trim();
  if (!/^eliza_host_[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    throw new TypeError("Remote host token is malformed");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(trimmed));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
