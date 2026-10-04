/** Browser-safe cryptographic encodings shared by account and service protocols. */
export const SIGNATURE_SCHEME = "v2";

export async function hmacSha256Hex(
  secret: string,
  canonical: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalSignedPayload(
  timestamp: string,
  deliveryId: string,
  eventType: string,
  body: string,
): string {
  return `${SIGNATURE_SCHEME}:${timestamp}.${deliveryId.length}:${deliveryId}.${eventType.length}:${eventType}.${body}`;
}

export async function generateCodeVerifier(): Promise<string> {
  const bytes = new Uint8Array(32); // 32 bytes → 43 base64url chars
  globalThis.crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return base64urlEncode(new Uint8Array(digest));
}

export function base64urlEncode(bytes: Uint8Array): string {
  // btoa is available in all browsers and Node 18+
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = await generateCodeVerifier();
  return { verifier, challenge: await generateCodeChallenge(verifier) };
}
