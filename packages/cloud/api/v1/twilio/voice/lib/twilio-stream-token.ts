/**
 * Mints and verifies one-use Twilio Media Stream bootstrap tokens whose signed
 * claims fix the call, tenant, agent, and conversation before socket upgrade.
 */

import { z } from "zod";

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 5;

const ClaimsSchema = z.object({
  v: z.literal(TOKEN_VERSION),
  sessionId: z.string().uuid(),
  jti: z.string().uuid(),
  exp: z.number().int().positive(),
  accountSid: z.string().min(1),
  callSid: z.string().min(1),
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  conversationId: z.string().uuid(),
  calledNumber: z.string().min(1),
});

export type TwilioStreamTokenClaims = z.infer<typeof ClaimsSchema>;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintTwilioStreamToken(
  input: Omit<TwilioStreamTokenClaims, "v" | "sessionId" | "jti" | "exp">,
  secret: string,
  now: () => number = Date.now,
): Promise<{ token: string; claims: TwilioStreamTokenClaims }> {
  if (!secret.trim())
    throw new Error("Twilio stream signing secret is required");
  const claims = ClaimsSchema.parse({
    ...input,
    v: TOKEN_VERSION,
    sessionId: crypto.randomUUID(),
    jti: crypto.randomUUID(),
    exp: Math.floor(now() / 1_000) + TOKEN_TTL_SECONDS,
  });
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await hmacKey(secret),
      new TextEncoder().encode(payload),
    ),
  );
  return { token: `${payload}.${encodeBase64Url(signature)}`, claims };
}

export async function verifyTwilioStreamToken(
  token: string,
  secret: string,
  now: () => number = Date.now,
): Promise<TwilioStreamTokenClaims | null> {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra || !secret.trim()) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64Url(encodedSignature).buffer as ArrayBuffer,
      new TextEncoder().encode(payload),
    );
    if (!valid) return null;
    const parsed = ClaimsSchema.safeParse(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))),
    );
    if (!parsed.success) return null;
    const nowSeconds = Math.floor(now() / 1_000);
    if (parsed.data.exp + CLOCK_SKEW_SECONDS < nowSeconds) return null;
    return parsed.data;
  } catch {
    // error-policy:J3 malformed bearer tokens are explicit invalid input.
    return null;
  }
}
