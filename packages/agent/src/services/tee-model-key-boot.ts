import { teeBootGateBlocksSecrets } from "./tee-boot-gate-state.ts";
import {
  type InferenceTopology,
  type ModelKeyUnsealResult,
  type SealedWeightsBlob,
  type SealedWeightsManifest,
  type ShardSink,
  type StreamingUnsealResult,
  unsealModelWeights,
  unsealModelWeightsStreaming,
} from "./tee-confidential-inference.ts";
import type { TeeMeasurementName } from "./tee-evidence.ts";
import type { TeeKeyReleaseClient } from "./tee-key-release.ts";
import type { TeeEvidencePolicy } from "./tee-policy.ts";

/**
 * Boot-time integration seam between the TEE confidential-inference unseal path
 * (`tee-confidential-inference.ts`) and the local model runtime (plan §2.2).
 *
 * WHY THIS IS A HELPER, NOT AN ALWAYS-ON BOOT CALL: weights loading lives in the
 * `@elizaos/plugin-local-inference` llama.cpp fork, not in the agent's
 * boot/runtime path. The agent never reads `*.gguf`/`*.safetensors` itself, so
 * there is no clean in-process seam in `runtime/eliza.ts` to gate. Rather than
 * fabricate a fake consumer, this module exposes the one function the
 * local-inference boot WILL call right before it hands weight bytes to the
 * runtime, behind the {@link CONFIDENTIAL_WEIGHTS_ENV} flag and inert by default.
 *
 * INTEGRATION (one line, to be added by the local-model runtime boot):
 *
 *     const confidential = await prepareConfidentialModelWeights({
 *       keyReleaseClient,            // HttpTeeKeyReleaseClient (prod) / LocalTeeKeyReleaseClient (dev)
 *       policy: teeBootGate.policy,  // the boot-gate's resolved + production-merged policy
 *       sealedWeights,               // the at-rest AES-256-GCM weights blob
 *       requiredMeasurements: [...], // agent, policy, container, os, npuFirmware, modelWeights
 *     });
 *     // confidential === undefined  -> flag off; load cleartext weights as before
 *     // confidential.weights        -> decrypted-in-memory bytes; hand to runtime, then zeroize
 *
 * FAIL-CLOSED: when {@link CONFIDENTIAL_WEIGHTS_ENV} is set, this never returns
 * cleartext weights without a passing attestation. It refuses (throws) when the
 * one-time boot gate already blocked secrets, then delegates to
 * {@link unsealModelWeights} which only decrypts after the key-release client's
 * evidence satisfies the policy. The decrypted weights/key never touch disk,
 * env, or the structured logger (enforced by `tee-secret-hygiene.test.ts`).
 */

/** Env flag that opts a deployment into attestation-gated confidential weights. */
export const CONFIDENTIAL_WEIGHTS_ENV = "ELIZA_CONFIDENTIAL_WEIGHTS" as const;

/**
 * True when the deployment opted into confidential weights. Truthy values are
 * `"1"` / `"true"` (case-insensitive); anything else (including unset) is inert.
 */
export function confidentialWeightsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[CONFIDENTIAL_WEIGHTS_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export type PrepareConfidentialModelWeightsConfig = {
  keyReleaseClient: TeeKeyReleaseClient;
  policy: TeeEvidencePolicy;
  sealedWeights: SealedWeightsBlob;
  requiredMeasurements: readonly TeeMeasurementName[];
  topology?: InferenceTopology;
  context?: string;
  /** Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>;
};

/**
 * The boot seam for single-blob confidential weights.
 *
 * - When {@link CONFIDENTIAL_WEIGHTS_ENV} is NOT set: returns `undefined`
 *   (inert). The caller loads cleartext weights exactly as before.
 * - When it IS set: refuses (throws) if the boot gate blocks secrets, otherwise
 *   unseals via {@link unsealModelWeights} (fail-closed) and returns the
 *   decrypted-in-memory weights. Never returns cleartext without attestation.
 */
export async function prepareConfidentialModelWeights(
  config: PrepareConfidentialModelWeightsConfig,
): Promise<ModelKeyUnsealResult | undefined> {
  const env = config.env ?? process.env;
  if (!confidentialWeightsEnabled(env)) return undefined;

  assertBootGateAllowsModelKey();

  return unsealModelWeights({
    keyReleaseClient: config.keyReleaseClient,
    policy: config.policy,
    sealedWeights: config.sealedWeights,
    requiredMeasurements: config.requiredMeasurements,
    ...(config.topology === undefined ? {} : { topology: config.topology }),
    ...(config.context === undefined ? {} : { context: config.context }),
  });
}

export type PrepareConfidentialModelWeightsStreamingConfig = {
  keyReleaseClient: TeeKeyReleaseClient;
  policy: TeeEvidencePolicy;
  sealedWeights: SealedWeightsManifest;
  requiredMeasurements: readonly TeeMeasurementName[];
  topology?: InferenceTopology;
  context?: string;
  env?: Record<string, string | undefined>;
};

/**
 * Streaming per-shard variant of {@link prepareConfidentialModelWeights} for a
 * large model whose plaintext must never be assembled in memory.
 *
 * - Flag off: returns `undefined` WITHOUT invoking `onShard` (inert; caller
 *   loads cleartext shards as before).
 * - Flag on: refuses if the boot gate blocks secrets, otherwise streams via
 *   {@link unsealModelWeightsStreaming} (fail-closed), handing one zeroized-after
 *   shard at a time to `onShard`.
 */
export async function prepareConfidentialModelWeightsStreaming(
  config: PrepareConfidentialModelWeightsStreamingConfig,
  onShard: ShardSink,
): Promise<StreamingUnsealResult | undefined> {
  const env = config.env ?? process.env;
  if (!confidentialWeightsEnabled(env)) return undefined;

  assertBootGateAllowsModelKey();

  return unsealModelWeightsStreaming(
    {
      keyReleaseClient: config.keyReleaseClient,
      policy: config.policy,
      sealedWeights: config.sealedWeights,
      requiredMeasurements: config.requiredMeasurements,
      ...(config.topology === undefined ? {} : { topology: config.topology }),
      ...(config.context === undefined ? {} : { context: config.context }),
    },
    onShard,
  );
}

/**
 * Fail closed if the one-time boot gate already determined that required TEE
 * evidence was not trusted — confidential weights must not unseal in that state.
 * Mirrors the state-volume guard in `tee-sealed-volume.ts`.
 */
function assertBootGateAllowsModelKey(): void {
  if (teeBootGateBlocksSecrets()) {
    throw new Error(
      "confidential model-weights unseal refused: TEE boot gate blocks secrets (untrusted evidence at boot).",
    );
  }
}
