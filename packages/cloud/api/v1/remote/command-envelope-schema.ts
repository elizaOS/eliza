/** Validation shared by the opaque remote command and result relay routes. */
import { z } from "zod";

const p256PublicJwk = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    d: z.never().optional(),
  })
  .strict();

export const encryptedRemoteEnvelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("ECDH-P256-HKDF-SHA256+A256GCM"),
    senderKeyId: z.string().min(1).max(256),
    recipientKeyId: z.string().min(1).max(256),
    ephemeralPublicKeyJwk: p256PublicJwk,
    salt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{24,1500000}$/),
  })
  .strict();

export const enqueueRemoteCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    sequence: z.number().int().safe().positive(),
    expiresAt: z.number().int().safe(),
    envelope: encryptedRemoteEnvelopeSchema,
  })
  .strict();

export const completeRemoteCommandSchema = z
  .object({
    claimAttempt: z.number().int().safe().positive(),
    resultEnvelope: encryptedRemoteEnvelopeSchema,
  })
  .strict();
