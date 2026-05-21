import { createDecipheriv, createHash } from "node:crypto";
import type { TeeMeasurementName } from "./tee-evidence.ts";
import type {
  TeeKeyReleaseClient,
  TeeKeyReleaseResult,
} from "./tee-key-release.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";

/**
 * Confidential-inference unseal path (plan §2.2 steps 4–7).
 *
 * Releases the `model-key` only after the TEE key-release client's evidence
 * satisfies the policy, then decrypts the at-rest weights blob in process
 * memory and hands the plaintext to the in-domain model runtime. The plaintext
 * weights and the model key never touch disk, env, or the structured logger.
 *
 * HARDWARE BOUNDARY (fail-closed): real TDX/CoVE quote-signature verification
 * is BLOCKED on hardware (plan Phase B2/C1). This path verifies a normalized
 * evidence document + nonce binding + measurement match only. It must not be
 * presented as hardware-verified trust until B2/C1 land. If the key-release
 * client rejects the evidence, no key is returned, the ciphertext stays sealed,
 * and unseal throws — the negative path is enforced by data unavailability,
 * not by a software flag that could be patched out.
 */

export const MODEL_KEY_ID = "model-key" as const;

/**
 * AES-256-GCM sealed weights envelope. A real device would store this per
 * shard; the shape is identical so streaming decrypt can be added later.
 */
export type SealedWeightsBlob = {
  algorithm: "aes-256-gcm";
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
  /**
   * SHA-256 of the plaintext weights. Bound into the policy as the
   * `modelWeights` measurement so `model-key` release is gated on the expected
   * weights digest (defense in depth, plan §6.2 / §8).
   */
  weightsSha256: string;
};

export type ModelKeyUnsealConfig = {
  keyReleaseClient: TeeKeyReleaseClient;
  policy: TeeEvidencePolicy;
  sealedWeights: SealedWeightsBlob;
  /**
   * Measurements that MUST be present and matched by the policy before the
   * model-key is released. For local private inference: agent, policy,
   * container/compose, os, npuFirmware, and modelWeights.
   */
  requiredMeasurements: readonly TeeMeasurementName[];
  context?: string;
};

export type ModelKeyUnsealResult = {
  /**
   * Decrypted weights in process memory. The caller must hand this directly to
   * the in-domain runtime and zeroize it after load. Never serialize it.
   */
  weights: Buffer;
  decision: TeeKeyReleaseResult["decision"];
  weightsSha256: string;
};

/**
 * Request `model-key`, verify the policy gates the required measurements, then
 * decrypt the sealed weights in memory. Fails closed on any gap.
 */
export async function unsealModelWeights(
  config: ModelKeyUnsealConfig,
): Promise<ModelKeyUnsealResult> {
  assertPolicyGatesRequiredMeasurements(
    config.policy,
    config.requiredMeasurements,
  );
  assertPolicyBindsWeightsDigest(config.policy, config.sealedWeights);

  const release = await config.keyReleaseClient.releaseKey({
    keyId: MODEL_KEY_ID,
    ...(config.context === undefined ? {} : { context: config.context }),
    policy: config.policy,
  });
  if (!release.decision.trusted) {
    throw new Error(
      `model-key release denied: ${release.decision.detail ?? release.decision.reason}`,
    );
  }

  const key = Buffer.from(release.keyMaterialHex, "hex");
  if (key.length !== 32) {
    throw new Error("model-key material must be 32 bytes for AES-256-GCM.");
  }
  try {
    const weights = decryptSealedWeights(config.sealedWeights, key);
    const actualDigest = createHash("sha256").update(weights).digest("hex");
    if (
      actualDigest !== normalizeDigestHex(config.sealedWeights.weightsSha256)
    ) {
      weights.fill(0);
      throw new Error(
        "Decrypted model weights digest does not match the sealed manifest.",
      );
    }
    return {
      weights,
      decision: release.decision,
      weightsSha256: actualDigest,
    };
  } finally {
    key.fill(0);
  }
}

function decryptSealedWeights(blob: SealedWeightsBlob, key: Buffer): Buffer {
  if (blob.algorithm !== "aes-256-gcm") {
    throw new Error(
      `Unsupported sealed-weights algorithm "${blob.algorithm}".`,
    );
  }
  const iv = Buffer.from(blob.ivBase64, "base64");
  const authTag = Buffer.from(blob.authTagBase64, "base64");
  const ciphertext = Buffer.from(blob.ciphertextBase64, "base64");
  if (iv.length !== 12) {
    throw new Error("AES-256-GCM IV must be 12 bytes.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  // GCM auth-tag verification throws here on tampered ciphertext/key —
  // a wrong (mismatched) key cannot silently yield garbage plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function assertPolicyGatesRequiredMeasurements(
  policy: TeeEvidencePolicy,
  required: readonly TeeMeasurementName[],
): void {
  const gated = policy.requiredMeasurements ?? {};
  const missing = required.filter(
    (name) => typeof gated[name] !== "string" || gated[name]?.trim() === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `model-key policy does not gate required measurements: ${missing.join(", ")}.`,
    );
  }
}

function assertPolicyBindsWeightsDigest(
  policy: TeeEvidencePolicy,
  blob: SealedWeightsBlob,
): void {
  const expected = policy.requiredMeasurements?.modelWeights;
  if (expected === undefined) return;
  if (normalizeDigestHex(expected) !== normalizeDigestHex(blob.weightsSha256)) {
    throw new Error(
      "model-key policy modelWeights digest does not match the sealed weights blob.",
    );
  }
}

function normalizeDigestHex(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("sha256:")
    ? trimmed.slice("sha256:".length)
    : trimmed;
}
