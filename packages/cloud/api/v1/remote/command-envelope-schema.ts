/** Validation shared by the opaque remote command and result relay routes. */
import { z } from "zod";

const p256PublicJwk = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(40).max(50),
    y: z.string().min(40).max(50),
    d: z.never().optional(),
  })
  .passthrough();

export const encryptedRemoteEnvelopeSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("ECDH-P256-HKDF-SHA256+A256GCM"),
  senderKeyId: z.string().min(1).max(256),
  recipientKeyId: z.string().min(1).max(256),
  ephemeralPublicKeyJwk: p256PublicJwk,
  salt: z.string().min(40).max(64),
  iv: z.string().min(16).max(32),
  ciphertext: z.string().min(24).max(1_500_000),
});

export const enqueueRemoteCommandSchema = z.object({
  commandId: z.string().uuid(),
  sequence: z.number().int().safe().positive(),
  expiresAt: z.number().int().safe(),
  envelope: encryptedRemoteEnvelopeSchema,
});

export const completeRemoteCommandSchema = z.object({
  resultEnvelope: encryptedRemoteEnvelopeSchema,
});
