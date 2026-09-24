/**
 * Produces the signed release identity consumed by the dstack CPU admission
 * profile. It hashes the exact measured compose bytes and keeps the signature
 * outside those bytes, so signing does not create a circular application hash.
 * Signing authorizes a release; it does not verify hardware or provision a VM.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const releaseInput = z
  .object({
    agentId: z.uuid(),
    compose: z.string().min(1),
    osImageHash: sha256,
    variant: z.enum(["dstack-tdx", "dstack-nitro-enclave"]),
    notBefore: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

export interface ConfidentialReleaseEnvelope {
  payload: string;
  signature: string;
}

const releaseIdentity = z
  .object({
    schemaVersion: z.literal(1),
    appId: z.string().regex(/^[a-f0-9]{40}$/),
    composeHash: sha256,
    osImageHash: sha256,
    variant: z.enum(["dstack-tdx", "dstack-nitro-enclave"]),
    notBefore: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

function validateReleaseInput(input: unknown): z.output<typeof releaseInput> {
  const release = releaseInput.parse(input);
  if (Date.parse(release.notBefore) >= Date.parse(release.expiresAt)) {
    throw new Error("Release validity interval must be nonempty");
  }
  const compose: unknown = JSON.parse(release.compose);
  const manifest = z
    .object({
      name: z.literal(`eliza-${release.agentId}`),
      manifest_version: z.literal("3"),
      key_provider: z.literal("kms"),
      key_provider_id: z.string().regex(/^(?:[a-f0-9]{2})+$/i),
      public_logs: z.literal(false),
      public_sysinfo: z.literal(false),
      no_instance_id: z.literal(false),
      secure_time: z.literal(true),
      storage_discard: z.literal(false),
      requirements: z.object({ platforms: z.array(z.string()).length(1) }),
    })
    .parse(compose);
  if (manifest.requirements.platforms[0] !== release.variant) {
    throw new Error("Release platform differs from measured guest requirement");
  }
  return release;
}

/** Authenticates the exact requested bytes before a deployment has side effects. */
export function verifyConfidentialRelease(
  input: unknown,
  envelope: ConfidentialReleaseEnvelope,
  publicKeyPem: string,
): z.output<typeof releaseIdentity> {
  try {
    const release = validateReleaseInput(input);
    const bytes = Buffer.from(envelope.payload, "base64");
    const signature = Buffer.from(envelope.signature, "base64");
    if (
      bytes.toString("base64") !== envelope.payload ||
      signature.length !== 64 ||
      signature.toString("base64") !== envelope.signature
    ) {
      throw new Error("Release envelope encoding is invalid");
    }
    const key = createPublicKey(publicKeyPem);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.concat([Buffer.from("eliza-dstack-release-v1\0"), bytes]),
        key,
        signature,
      )
    ) {
      throw new Error("Release authority signature rejected");
    }
    const identity = releaseIdentity.parse(JSON.parse(bytes.toString("utf8")));
    const composeHash = createHash("sha256")
      .update(release.compose)
      .digest("hex");
    if (
      identity.appId !== composeHash.slice(0, 40) ||
      identity.composeHash !== composeHash ||
      identity.osImageHash !== release.osImageHash ||
      identity.variant !== release.variant ||
      identity.notBefore !== release.notBefore ||
      identity.expiresAt !== release.expiresAt
    ) {
      throw new Error("Requested deployment differs from signed release");
    }
    const now = Date.now();
    if (
      Date.parse(identity.notBefore) > now ||
      Date.parse(identity.expiresAt) <= now ||
      Date.parse(identity.notBefore) >= Date.parse(identity.expiresAt)
    ) {
      throw new Error("Release is outside its validity interval");
    }
    return identity;
  } catch (cause) {
    // error-policy:J2 No deployment may proceed with an unauthenticated identity.
    throw new ElizaError("Cannot verify confidential release identity", {
      code: "CONFIDENTIAL_RELEASE_INVALID",
      cause,
    });
  }
}

/**
 * Signs a new application identity; upgrades retaining an earlier app ID need
 * a separate explicit authorization flow and are intentionally not inferred.
 */
export function signConfidentialRelease(
  input: unknown,
  privateKeyPem: string,
): ConfidentialReleaseEnvelope {
  try {
    const release = validateReleaseInput(input);
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Release authority must use Ed25519");
    }
    const composeHash = createHash("sha256")
      .update(release.compose)
      .digest("hex");
    const payload = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        // The dstack new-app protocol uses the first 20 bytes of the compose hash.
        appId: composeHash.slice(0, 40),
        composeHash,
        osImageHash: release.osImageHash,
        variant: release.variant,
        notBefore: release.notBefore,
        expiresAt: release.expiresAt,
      }),
    );
    const signature = sign(
      null,
      Buffer.concat([Buffer.from("eliza-dstack-release-v1\0"), payload]),
      privateKey,
    );
    return {
      payload: payload.toString("base64"),
      signature: signature.toString("base64"),
    };
  } catch (cause) {
    // error-policy:J2 Invalid release inputs never yield a signed authorization.
    throw new ElizaError("Cannot sign confidential release identity", {
      code: "CONFIDENTIAL_RELEASE_INVALID",
      cause,
    });
  }
}
