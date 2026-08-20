/**
 * Mints and verifies one-use Twilio Media Stream bootstrap tokens whose signed
 * claims fix the call, tenant, agent, and conversation before socket upgrade.
 */

import { z } from "zod";
import { isPersonalSharedAgentId } from "@/lib/services/shared-runtime/personal-shared-agent";

const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 5;

const ConversationIdSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      z.string().uuid().safeParse(value).success ||
      isPersonalSharedAgentId(value),
    "conversationId must be a UUID or personal Shared agent id",
  );

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
  conversationId: ConversationIdSchema,
  calledNumber: z.string().min(1),
  callerNumber: z.string().min(1).optional(),
  platformGuest: z.boolean().optional(),
  returningCaller: z.boolean(),
  previousInteractionAt: z.number().int().positive().optional(),
});

const WireClaimsSchema = z.object({
  v: z.literal(TOKEN_VERSION),
  s: z.string().uuid(),
  j: z.string().uuid(),
  e: z.number().int().positive(),
  a: z.string().min(1),
  c: z.string().min(1),
  o: z.string().min(1),
  u: z.string().min(1),
  g: z.string().min(1),
  n: ConversationIdSchema,
  p: z.string().min(1),
  f: z.string().min(1).optional(),
  x: z.boolean().optional(),
  r: z.boolean(),
  l: z.number().int().positive().optional(),
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
  input: Omit<TwilioStreamTokenClaims, "v" | "sessionId" | "jti" | "exp"> & {
    callerNumber: string;
  },
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
    new TextEncoder().encode(
      JSON.stringify({
        v: claims.v,
        s: claims.sessionId,
        j: claims.jti,
        e: claims.exp,
        a: claims.accountSid,
        c: claims.callSid,
        o: claims.organizationId,
        u: claims.userId,
        g: claims.agentId,
        n: claims.conversationId,
        p: claims.calledNumber,
        ...(claims.callerNumber ? { f: claims.callerNumber } : {}),
        ...(claims.platformGuest ? { x: true } : {}),
        r: claims.returningCaller,
        ...(claims.previousInteractionAt
          ? { l: claims.previousInteractionAt }
          : {}),
      }),
    ),
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
    const wire = WireClaimsSchema.safeParse(
      JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))),
    );
    if (!wire.success) return null;
    const parsed = ClaimsSchema.safeParse({
      v: wire.data.v,
      sessionId: wire.data.s,
      jti: wire.data.j,
      exp: wire.data.e,
      accountSid: wire.data.a,
      callSid: wire.data.c,
      organizationId: wire.data.o,
      userId: wire.data.u,
      agentId: wire.data.g,
      conversationId: wire.data.n,
      calledNumber: wire.data.p,
      callerNumber: wire.data.f,
      platformGuest: wire.data.x,
      returningCaller: wire.data.r,
      previousInteractionAt: wire.data.l,
    });
    if (!parsed.success) return null;
    const nowSeconds = Math.floor(now() / 1_000);
    if (parsed.data.exp + CLOCK_SKEW_SECONDS < nowSeconds) return null;
    return parsed.data;
  } catch {
    // error-policy:J3 malformed bearer tokens are explicit invalid input.
    return null;
  }
}
