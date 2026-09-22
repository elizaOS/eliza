/**
 * Authenticates deployment identity supplied after compose measurement using an
 * Ed25519 release authority anchored inside that compose/image. The signed
 * envelope stays outside compose, avoiding a self-referential compose hash.
 */
import { createPublicKey, verify } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { dstackEvidenceConfiguration } from "./tee-dstack-evidence.ts";

export const DSTACK_RELEASE_SIGNATURE_DOMAIN = "eliza-dstack-release-v1\0";
const releaseSchema = dstackEvidenceConfiguration
  .pick({ appId: true, composeHash: true, osImageHash: true, variant: true })
  .extend({
    schemaVersion: z.literal(1),
    notBefore: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
const envelopeSchema = z
  .object({
    payload: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(16_384),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();

/** Signed mode is mandatory for the CPU production profile, optional elsewhere. */
export function resolveDstackEvidenceConfiguration(
  env: Record<string, string | undefined>,
): z.output<typeof dstackEvidenceConfiguration> {
  try {
    const configuration = env.ELIZA_DSTACK_EVIDENCE_CONFIG_JSON;
    if (configuration === undefined)
      throw new Error("Missing evidence configuration");
    const raw: unknown = JSON.parse(configuration);
    const signed = env.ELIZA_DSTACK_RELEASE_POLICY_JSON;
    const anchor = env.ELIZA_DSTACK_RELEASE_PUBKEY;
    const required = env.ELIZA_TEE_PRODUCTION_PROFILE === "dstack-cpu";
    if (!required && signed === undefined && anchor === undefined) {
      return dstackEvidenceConfiguration.parse(raw);
    }
    if (signed === undefined || anchor === undefined)
      throw new Error("Missing signed release policy or authority key");
    const key = createPublicKey(anchor);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("Release authority must use Ed25519");
    const envelope = envelopeSchema.parse(JSON.parse(signed));
    const payload = Buffer.from(envelope.payload, "base64");
    if (payload.toString("base64") !== envelope.payload)
      throw new Error("Noncanonical release payload encoding");
    if (
      !verify(
        null,
        Buffer.concat([Buffer.from(DSTACK_RELEASE_SIGNATURE_DOMAIN), payload]),
        key,
        Buffer.from(envelope.signature, "base64"),
      )
    ) {
      throw new Error("Release identity signature rejected");
    }
    const identity = releaseSchema.parse(JSON.parse(payload.toString("utf8")));
    const now = Date.now();
    if (
      Date.parse(identity.notBefore) > now ||
      Date.parse(identity.expiresAt) <= now ||
      Date.parse(identity.notBefore) >= Date.parse(identity.expiresAt)
    )
      throw new Error("Release identity outside its validity interval");
    const local = dstackEvidenceConfiguration
      .partial({ appId: true, composeHash: true, osImageHash: true })
      .parse(raw);
    for (const field of [
      "appId",
      "composeHash",
      "osImageHash",
      "variant",
    ] as const) {
      if (
        local[field] !== undefined &&
        local[field]?.toLowerCase() !== identity[field].toLowerCase()
      ) {
        throw new Error(
          "Measured configuration conflicts with signed release identity",
        );
      }
    }
    return dstackEvidenceConfiguration.parse({
      ...local,
      ...identity,
      releaseValidity: {
        notBefore: identity.notBefore,
        expiresAt: identity.expiresAt,
      },
    });
  } catch (error) {
    // error-policy:J2 Unauthenticated or expired release identity never becomes admission policy.
    throw new ElizaError("Invalid dstack release configuration", {
      code: "TEE_DSTACK_RELEASE_INVALID",
      cause: error,
    });
  }
}
