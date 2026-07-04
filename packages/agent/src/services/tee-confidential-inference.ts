/**
 * Confidential-inference unseal surface: releases the `model-key` through an
 * attestation-gated key-release client and decrypts at-rest AES-256-GCM sealed
 * weights — single-blob or streaming per-shard — in process memory for the
 * in-domain model runtime. Every seam fails closed (policy gates, digest
 * bindings, GCM auth tags), and plaintext weights/key material are zeroized and
 * never touch disk, env, or the logger. See the block below for the hardware
 * boundary: real TDX/CoVE quote verification is not yet enforced on this path.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
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
 * Deployment topology of the private-inference path (plan §2.5).
 *
 * - `local` (default): weights decrypt inside the on-device CVM/TVM and the
 *   model runs against the chip NPU confidential-I/O lane. The policy MUST gate
 *   `claims.npuProtected === true` and a `measurements.npuFirmware` golden
 *   digest before any `model-key` release.
 * - `cloud`: weights decrypt inside a remote dstack CVM behind a confidential
 *   H100 GPU. The policy MUST gate `claims.gpuProtected === true` and a
 *   `measurements.gpuFirmware` golden digest instead.
 */
export type InferenceTopology = "local" | "cloud";

const DEFAULT_INFERENCE_TOPOLOGY: InferenceTopology = "local";

/**
 * Fail-closed gate binding private inference to the confidential-I/O attestation
 * lane (plan §2.4, Phase C item C2). For the local topology this enforces that
 * the policy will only release the `model-key` against evidence that proves the
 * NPU confidential-I/O lane is active:
 *
 *   - `requiredClaims.npuProtected === true`, and
 *   - `requiredMeasurements.npuFirmware` is a non-empty golden digest.
 *
 * For the cloud topology it enforces the H100 confidential-GPU equivalent
 * (`gpuProtected` + `gpuFirmware`). This is an explicit, reusable assertion so
 * "no NPU/GPU confidential-I/O attestation ⇒ no private inference" is enforced
 * at the unseal seam, not left as an implicit production-profile default a
 * caller could forget. It checks that the *policy itself* will demand these
 * gates; `evaluateTeeEvidencePolicy` then enforces them against the evidence at
 * release time. It throws (fails closed) on any gap.
 */
export function assertNpuPrivateInferenceAllowed(
  policy: TeeEvidencePolicy,
  topology: InferenceTopology = DEFAULT_INFERENCE_TOPOLOGY,
): void {
  const claim = topology === "local" ? "npuProtected" : "gpuProtected";
  const firmware: TeeMeasurementName =
    topology === "local" ? "npuFirmware" : "gpuFirmware";

  if (policy.requiredClaims?.[claim] !== true) {
    throw new Error(
      `private inference (${topology}) requires the policy to gate claim "${claim}" === true; ` +
        "refusing to release model-key without the confidential-I/O attestation.",
    );
  }

  const digest = policy.requiredMeasurements?.[firmware];
  if (typeof digest !== "string" || digest.trim() === "") {
    throw new Error(
      `private inference (${topology}) requires the policy to gate a non-empty "${firmware}" measurement; ` +
        "refusing to release model-key without the confidential-I/O firmware golden digest.",
    );
  }
}

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

/**
 * One AES-256-GCM-sealed shard of the weights. Shards are ordered by `index`
 * (0-based, contiguous) and concatenate — in order — to the full plaintext. Each
 * shard carries its own IV + GCM auth tag, so a large model can stream-decrypt
 * shard-by-shard without ever assembling the full plaintext in memory.
 */
export type SealedWeightsShard = {
  index: number;
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
  /** SHA-256 of this shard's plaintext (defense in depth on top of the GCM tag). */
  plaintextSha256: string;
};

/**
 * Per-shard sealed weights envelope (plan §8 recommendation). The single-blob
 * {@link SealedWeightsBlob} remains supported; this shape lets the streaming
 * unseal decrypt and hand off one shard at a time.
 */
export type SealedWeightsManifest = {
  algorithm: "aes-256-gcm";
  /** SHA-256 of the FULL concatenated plaintext (matches the single-blob digest). */
  weightsSha256: string;
  shards: SealedWeightsShard[];
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
  /**
   * Deployment topology (plan §2.5). Defaults to `local`, which gates the chip
   * NPU confidential-I/O lane (`npuProtected` + `npuFirmware`). `cloud` gates
   * the confidential-GPU lane (`gpuProtected` + `gpuFirmware`) instead.
   */
  topology?: InferenceTopology;
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
  assertNpuPrivateInferenceAllowed(
    config.policy,
    config.topology ?? DEFAULT_INFERENCE_TOPOLOGY,
  );
  assertPolicyGatesRequiredMeasurements(
    config.policy,
    config.requiredMeasurements,
  );
  assertPolicyBindsWeightsDigest(
    config.policy,
    config.sealedWeights.weightsSha256,
  );

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
    if (!digestsEqual(actualDigest, config.sealedWeights.weightsSha256)) {
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

export type StreamingUnsealConfig = {
  keyReleaseClient: TeeKeyReleaseClient;
  policy: TeeEvidencePolicy;
  sealedWeights: SealedWeightsManifest;
  /**
   * Measurements that MUST be present and matched by the policy before the
   * model-key is released (same gate as {@link unsealModelWeights}).
   */
  requiredMeasurements: readonly TeeMeasurementName[];
  /**
   * Deployment topology (plan §2.5). Defaults to `local` (NPU confidential-I/O).
   * See {@link ModelKeyUnsealConfig.topology}.
   */
  topology?: InferenceTopology;
  context?: string;
};

export type StreamingUnsealResult = {
  decision: TeeKeyReleaseResult["decision"];
  weightsSha256: string;
  shardCount: number;
};

/**
 * Sink for one decrypted shard. The buffer is valid only for the duration of
 * this call: the streaming unseal zeroizes it immediately after `onShard`
 * returns, before decrypting the next shard. The sink must consume (e.g. copy
 * into the in-domain runtime) what it needs synchronously or via the awaited
 * promise; it must not retain the buffer.
 */
export type ShardSink = (shard: {
  index: number;
  bytes: Buffer;
}) => void | Promise<void>;

/**
 * Streaming per-shard unseal (plan §8 recommendation). Applies the same
 * fail-closed gates as {@link unsealModelWeights}, then decrypts shards strictly
 * in order, handing each plaintext shard to `onShard` and zeroizing it before
 * decrypting the next — so the full plaintext is never assembled in memory. A
 * running SHA-256 over the concatenated plaintext is verified against the
 * manifest `weightsSha256` at the end (defense in depth). On any failure all
 * transient buffers and the key material are zeroized and the call throws.
 */
export async function unsealModelWeightsStreaming(
  config: StreamingUnsealConfig,
  onShard: ShardSink,
): Promise<StreamingUnsealResult> {
  assertNpuPrivateInferenceAllowed(
    config.policy,
    config.topology ?? DEFAULT_INFERENCE_TOPOLOGY,
  );
  assertPolicyGatesRequiredMeasurements(
    config.policy,
    config.requiredMeasurements,
  );
  assertPolicyBindsWeightsDigest(
    config.policy,
    config.sealedWeights.weightsSha256,
  );
  if (config.sealedWeights.algorithm !== "aes-256-gcm") {
    throw new Error(
      `Unsupported sealed-weights algorithm "${config.sealedWeights.algorithm}".`,
    );
  }
  const shards = assertOrderedShards(config.sealedWeights.shards);

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
    const running = createHash("sha256");
    for (const shard of shards) {
      // Only one plaintext shard exists at a time; it is zeroized below before
      // the loop advances, so no full-plaintext buffer is ever assembled here.
      const bytes = decryptAesGcmSegment(shard, key);
      try {
        const shardDigest = createHash("sha256").update(bytes).digest("hex");
        if (!digestsEqual(shardDigest, shard.plaintextSha256)) {
          throw new Error(
            `Decrypted shard ${shard.index} digest does not match the sealed manifest.`,
          );
        }
        running.update(bytes);
        await onShard({ index: shard.index, bytes });
      } finally {
        bytes.fill(0);
      }
    }
    const actualDigest = running.digest("hex");
    if (!digestsEqual(actualDigest, config.sealedWeights.weightsSha256)) {
      throw new Error(
        "Reassembled model weights digest does not match the sealed manifest.",
      );
    }
    return {
      decision: release.decision,
      weightsSha256: actualDigest,
      shardCount: shards.length,
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Seal `weights` into a per-shard {@link SealedWeightsManifest} under `key`,
 * splitting into `shardSizeBytes`-sized shards (the last may be smaller). Each
 * shard gets a fresh 12-byte IV. Used by tests and any real packer; reuses the
 * single-blob crypto patterns.
 */
export function sealModelWeightsShards(input: {
  weights: Buffer;
  key: Buffer;
  shardSizeBytes: number;
}): SealedWeightsManifest {
  if (input.key.length !== 32) {
    throw new Error("seal key must be 32 bytes for AES-256-GCM.");
  }
  if (!Number.isInteger(input.shardSizeBytes) || input.shardSizeBytes <= 0) {
    throw new Error("shardSizeBytes must be a positive integer.");
  }
  if (input.weights.length === 0) {
    throw new Error("cannot seal empty weights.");
  }
  const shards: SealedWeightsShard[] = [];
  let index = 0;
  for (
    let offset = 0;
    offset < input.weights.length;
    offset += input.shardSizeBytes
  ) {
    const plaintext = input.weights.subarray(
      offset,
      Math.min(offset + input.shardSizeBytes, input.weights.length),
    );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", input.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    shards.push({
      index,
      ivBase64: iv.toString("base64"),
      authTagBase64: cipher.getAuthTag().toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
      plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
    });
    index += 1;
  }
  return {
    algorithm: "aes-256-gcm",
    weightsSha256: createHash("sha256").update(input.weights).digest("hex"),
    shards,
  };
}

/**
 * Verify shards form a contiguous 0-based sequence and return them sorted by
 * `index` so decryption proceeds strictly in plaintext order.
 */
function assertOrderedShards(
  shards: readonly SealedWeightsShard[],
): SealedWeightsShard[] {
  if (shards.length === 0) {
    throw new Error("sealed-weights manifest has no shards.");
  }
  const ordered = [...shards].sort((a, b) => a.index - b.index);
  ordered.forEach((shard, position) => {
    if (shard.index !== position) {
      throw new Error(
        `sealed-weights shard indices must be contiguous from 0; got index ${shard.index} at position ${position}.`,
      );
    }
  });
  return ordered;
}

/** Constant-time hex-digest comparison after normalizing the `sha256:` prefix. */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(normalizeDigestHex(a), "hex");
  const right = Buffer.from(normalizeDigestHex(b), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Decrypt one AES-256-GCM segment (IV + auth tag + ciphertext, all base64). GCM
 * auth-tag verification throws on tampered ciphertext or a wrong/mismatched key,
 * so this can never silently yield garbage plaintext. Shared by the single-blob
 * and per-shard paths.
 */
function decryptAesGcmSegment(
  segment: {
    ivBase64: string;
    authTagBase64: string;
    ciphertextBase64: string;
  },
  key: Buffer,
): Buffer {
  const iv = Buffer.from(segment.ivBase64, "base64");
  if (iv.length !== 12) {
    throw new Error("AES-256-GCM IV must be 12 bytes.");
  }
  const authTag = Buffer.from(segment.authTagBase64, "base64");
  const ciphertext = Buffer.from(segment.ciphertextBase64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptSealedWeights(blob: SealedWeightsBlob, key: Buffer): Buffer {
  if (blob.algorithm !== "aes-256-gcm") {
    throw new Error(
      `Unsupported sealed-weights algorithm "${blob.algorithm}".`,
    );
  }
  return decryptAesGcmSegment(blob, key);
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
  weightsSha256: string,
): void {
  const expected = policy.requiredMeasurements?.modelWeights;
  if (expected === undefined) return;
  if (normalizeDigestHex(expected) !== normalizeDigestHex(weightsSha256)) {
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
