import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { teeBootGateBlocksSecrets } from "./tee-boot-gate-state.ts";
import type { TeeMeasurementName } from "./tee-evidence.ts";
import type {
  TeeKeyReleaseClient,
  TeeKeyReleaseResult,
} from "./tee-key-release.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";

/**
 * Attestation-bound sealed state-volume key manager (plan §2.3 / Phase C item
 * C3). Replaces dstack's host-readable LUKS2 key (GHSA-jxq2-hpw3-m5wf, plan
 * §5.5) with a key that is RELEASED ONLY after a passing attestation.
 *
 * SCOPE OF THIS MODULE — the security-critical, host-agnostic binding layer:
 * it requests the state-volume key through the existing attestation-gated
 * key-release + policy path and refuses (fail-closed) when the evidence is not
 * trusted or the boot gate already blocked secrets. The key is bound to the
 * measured agent/policy/device identity, so a tampered OS/agent yields a
 * DIFFERENT key and the volume simply will not decrypt — the negative path is
 * enforced by *data unavailability*, not by a software flag that could be
 * patched out. This mirrors the confidential-inference `model-key` unseal
 * pattern (`tee-confidential-inference.ts`).
 *
 * NOT IN SCOPE — the OS layer (`packages/os/docs/tee-os-implementation-plan.md`
 * §3.4): the dm-crypt/LUKS2 plumbing itself. A mount hook in the confidential
 * guest calls {@link unsealStateVolumeKey} BEFORE mounting the state dir,
 * hands the released key (or the LUKS passphrase recovered from the
 * sealed metadata blob) to `cryptsetup`, and refuses to mount when this throws.
 * That plumbing is host-specific and not unit-testable in memory; the
 * attestation→key binding here is, and it is the part that matters for the
 * security property.
 *
 * HARDWARE BOUNDARY (fail-closed): real TDX/CoVE quote-signature verification
 * is BLOCKED on hardware (plan Phase B2/C1). This path verifies a normalized
 * evidence document + measurement match via the key-release client only; it
 * must not be presented as hardware-verified trust until B2/C1 land.
 */

/**
 * Key-release scope for the per-user sealed state volume. Distinct from
 * `model-key` so the volume key and the weights key derive from independent
 * KMS-side material even under the same measured identity. Maps to a dstack
 * `keyId` in production (plan §3.5).
 */
export const STATE_VOLUME_KEY_ID = "state-volume" as const;

/**
 * Measurements that MUST be gated by the policy before the state-volume key is
 * released. The volume holds the user's agent-session secret scope, so its key
 * is bound to the measured agent, the release policy, and the device identity:
 * change any one and the released key changes, and the volume will not mount.
 */
export const STATE_VOLUME_REQUIRED_MEASUREMENTS: readonly TeeMeasurementName[] =
  ["agent", "policy", "device"] as const;

export type UnsealStateVolumeKeyConfig = {
  keyReleaseClient: TeeKeyReleaseClient;
  policy: TeeEvidencePolicy;
  /**
   * Measurements the policy MUST gate before release. Defaults to
   * {@link STATE_VOLUME_REQUIRED_MEASUREMENTS}. A caller may add more (e.g.
   * `os`, `boot`) for a stricter mount.
   */
  requiredMeasurements?: readonly TeeMeasurementName[];
  /** Optional KDF context forwarded to the key-release client. */
  context?: string;
};

export type UnsealStateVolumeKeyResult = {
  /**
   * Released 32-byte volume key, hex-encoded. The OS-side mount hook hands this
   * to dm-crypt/LUKS2 (or uses it to open {@link openSealedVolumeMetadata}).
   * The caller must zeroize the derived buffer after handing it to the kernel
   * keyring; it must never be written to disk, env, or the structured logger.
   */
  keyMaterialHex: string;
  decision: TeeKeyReleaseResult["decision"];
};

/**
 * Request the `state-volume` key, gated by the attestation policy. Fails closed
 * when the boot gate already blocked secrets, when the policy does not gate the
 * required measurements, or when the released decision is not trusted. On
 * success returns the released key material for the OS layer to hand to
 * dm-crypt/LUKS2.
 */
export async function unsealStateVolumeKey(
  config: UnsealStateVolumeKeyConfig,
): Promise<UnsealStateVolumeKeyResult> {
  // Fail closed if the one-time boot gate already determined that required TEE
  // evidence was not trusted — the volume must not mount in that state.
  if (teeBootGateBlocksSecrets()) {
    throw new Error(
      "state-volume key release refused: TEE boot gate blocks secrets (untrusted evidence at boot).",
    );
  }

  const required =
    config.requiredMeasurements ?? STATE_VOLUME_REQUIRED_MEASUREMENTS;
  assertPolicyGatesRequiredMeasurements(config.policy, required);

  const release = await config.keyReleaseClient.releaseKey({
    keyId: STATE_VOLUME_KEY_ID,
    ...(config.context === undefined ? {} : { context: config.context }),
    policy: config.policy,
  });
  if (!release.decision.trusted) {
    throw new Error(
      `state-volume key release denied: ${
        release.decision.detail ?? release.decision.reason
      }`,
    );
  }

  if (!/^[a-f0-9]{64}$/.test(release.keyMaterialHex)) {
    throw new Error(
      "state-volume key material must be 32 bytes (hex) for AES-256 / LUKS2.",
    );
  }

  return {
    keyMaterialHex: release.keyMaterialHex,
    decision: release.decision,
  };
}

/**
 * AES-256-GCM envelope holding small volume metadata — most importantly the
 * actual LUKS2 passphrase. Storing the passphrase inside an attestation-bound
 * envelope (rather than handing the released key directly to LUKS) lets the
 * LUKS keyslot be re-keyed independently of the attested identity while keeping
 * the *only* path to the passphrase gated on attestation. Same shape as
 * `SealedWeightsBlob` so the binding property is end-to-end testable in memory.
 */
export type SealedVolumeMetadata = {
  algorithm: "aes-256-gcm";
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
  /**
   * SHA-256 of the plaintext metadata, verified after decrypt as defense in
   * depth on top of the GCM auth tag.
   */
  metadataSha256: string;
};

/**
 * Seal a small metadata blob (e.g. the LUKS2 passphrase envelope) under the
 * attestation-released volume key. The key must be the 32-byte hex value from
 * {@link unsealStateVolumeKey}. Used by the OS-side provisioning hook and by
 * tests; mirrors the single-blob seal in `tee-confidential-inference.ts`.
 */
export function sealVolumeMetadata(input: {
  metadata: Buffer;
  keyMaterialHex: string;
}): SealedVolumeMetadata {
  const key = keyFromHex(input.keyMaterialHex);
  try {
    if (input.metadata.length === 0) {
      throw new Error("cannot seal empty volume metadata.");
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(input.metadata),
      cipher.final(),
    ]);
    return {
      algorithm: "aes-256-gcm",
      ivBase64: iv.toString("base64"),
      authTagBase64: cipher.getAuthTag().toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
      metadataSha256: createHash("sha256").update(input.metadata).digest("hex"),
    };
  } finally {
    key.fill(0);
  }
}

/**
 * Open the sealed volume metadata with the attestation-released key. Because
 * the key is bound to the measured identity, a key released for a DIFFERENT
 * agent/policy/device fails the GCM auth-tag check here and yields no
 * plaintext — proving the volume key is attestation-bound. The returned buffer
 * holds the LUKS passphrase / metadata; the caller must zeroize it after use.
 */
export function openSealedVolumeMetadata(
  sealed: SealedVolumeMetadata,
  keyMaterialHex: string,
): Buffer {
  if (sealed.algorithm !== "aes-256-gcm") {
    throw new Error(
      `Unsupported sealed-volume algorithm "${sealed.algorithm}".`,
    );
  }
  const key = keyFromHex(keyMaterialHex);
  try {
    const iv = Buffer.from(sealed.ivBase64, "base64");
    if (iv.length !== 12) {
      throw new Error("AES-256-GCM IV must be 12 bytes.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(Buffer.from(sealed.authTagBase64, "base64"));
    // A key derived from tampered evidence (wrong measured identity) fails the
    // GCM tag check here rather than yielding usable plaintext.
    const metadata = Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertextBase64, "base64")),
      decipher.final(),
    ]);
    const actualDigest = createHash("sha256").update(metadata).digest("hex");
    if (!digestsEqual(actualDigest, sealed.metadataSha256)) {
      metadata.fill(0);
      throw new Error(
        "Decrypted volume metadata digest does not match the sealed envelope.",
      );
    }
    return metadata;
  } finally {
    key.fill(0);
  }
}

function keyFromHex(keyMaterialHex: string): Buffer {
  const key = Buffer.from(keyMaterialHex, "hex");
  if (key.length !== 32) {
    throw new Error("volume key material must be 32 bytes for AES-256-GCM.");
  }
  return key;
}

function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
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
      `state-volume policy does not gate required measurements: ${missing.join(", ")}.`,
    );
  }
}
