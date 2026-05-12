// Runtime validator and capability-check helpers for Eliza-1 manifests.
//
// Two layers of validation:
//
//   1. Schema validation (Zod)        — shape + types + per-field invariants.
//   2. Contract validation (this file) — cross-field rules from
//                                        packages/inference/AGENTS.md §3 + §6:
//        - required-kernel set per tier is satisfied,
//        - long-context bundles (ctx > 64k) require `turbo3_tcq`,
//        - every backend the tier supports has `verifiedBackends.<b>.status === "pass"`,
//        - every eval has `passed: true` (and `e2eLoopOk` / `thirtyTurnOk`).
//
// `defaultEligible: true` is the strongest claim a manifest can make. The
// validator REFUSES the combination of `defaultEligible: true` and any
// failing contract rule. This mirrors the publish-side gate in
// `packages/training/scripts/manifest/eliza1_manifest.py`.

import {
  Eliza1ManifestSchema,
  REQUIRED_KERNELS_BY_TIER,
  SUPPORTED_BACKENDS_BY_TIER,
  VOICE_PRESET_CACHE_PATH,
} from "./schema";
import type {
  Eliza1Backend,
  Eliza1DeviceCaps,
  Eliza1Kernel,
  Eliza1Manifest,
  Eliza1Tier,
} from "./types";

export interface ValidationOk {
  ok: true;
  manifest: Eliza1Manifest;
}

export interface ValidationErr {
  ok: false;
  errors: ReadonlyArray<string>;
}

export type ValidationResult = ValidationOk | ValidationErr;

/**
 * Schema + contract validation. Returns a Result-shaped object so callers
 * can inspect every error rather than catching the first thrown one.
 *
 * Throws nothing for invalid input — invalid manifests are reported via
 * `{ ok: false, errors }`. Truly exceptional cases (non-object input)
 * surface as Zod issues, not exceptions.
 */
export function validateManifest(input: unknown): ValidationResult {
  const parsed = Eliza1ManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
      ),
    };
  }

  const errors = collectContractErrors(parsed.data);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, manifest: parsed.data };
}

/**
 * Throws on invalid input. Use this from boot paths where a structured
 * error is already attached at the boundary. Internal use only — UI
 * code should prefer `validateManifest`.
 */
export function parseManifestOrThrow(input: unknown): Eliza1Manifest {
  const result = validateManifest(input);
  if (result.ok === false) {
    throw new Error(
      `Invalid Eliza-1 manifest:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return result.manifest;
}

/**
 * `canSetAsDefault` is the recommendation-engine gate. A manifest that
 * passes this is allowed to be picked as the default bundle for the
 * device — it is `defaultEligible`, contract-valid, AND every backend
 * it claims to verify is one the device exposes.
 *
 * The device-caps check rejects "this device has Vulkan only but the
 * manifest only verified Metal/CUDA" — a manifest may be globally
 * default-eligible but not on this device.
 */
export function canSetAsDefault(
  manifest: Eliza1Manifest,
  device: Eliza1DeviceCaps,
): boolean {
  if (!manifest.defaultEligible) return false;
  if (collectContractErrors(manifest).length > 0) return false;
  if (manifest.ramBudgetMb.min > device.ramMb) return false;

  // The device must expose at least one backend that the manifest verified
  // pass on. Pre-check against the tier's supported set so we don't accept
  // a tier-server bundle on a Mac via the cpu fallback alone.
  const supported = new Set<Eliza1Backend>(
    SUPPORTED_BACKENDS_BY_TIER[manifest.tier],
  );
  const overlapping = device.availableBackends.filter(
    (b) =>
      supported.has(b) &&
      manifest.kernels.verifiedBackends[b].status === "pass",
  );
  return overlapping.length > 0;
}

// ---------------------------------------------------------------------------
// Internal: contract rules from AGENTS.md §3 + §6
// ---------------------------------------------------------------------------

function collectContractErrors(m: Eliza1Manifest): string[] {
  const errors: string[] = [];

  // Required-kernel coverage.
  const declaredRequired = new Set<Eliza1Kernel>(m.kernels.required);
  const tierRequired = REQUIRED_KERNELS_BY_TIER[m.tier];
  for (const k of tierRequired) {
    if (!declaredRequired.has(k)) {
      errors.push(
        `kernels.required: missing required kernel for tier ${m.tier}: ${k}`,
      );
    }
  }

  // Long-context tiers MUST require turbo3_tcq once any text variant has
  // ctx > 64k. AGENTS.md §3 Required for desktop/pro/server (#6).
  const hasLongContextVariant = m.files.text.some(
    (f) => typeof f.ctx === "number" && f.ctx > 65536,
  );
  if (hasLongContextVariant) {
    if (!declaredRequired.has("turbo3_tcq")) {
      errors.push(
        "kernels.required: text variant with ctx > 64k requires turbo3_tcq",
      );
    }
  }

  // Every supported backend for this tier must report pass.
  const supportedBackends = SUPPORTED_BACKENDS_BY_TIER[m.tier];
  for (const b of supportedBackends) {
    const status = m.kernels.verifiedBackends[b].status;
    if (status !== "pass") {
      errors.push(
        `kernels.verifiedBackends.${b}: status is "${status}", expected "pass" for tier ${m.tier}`,
      );
    }
  }

  // The precomputed default-voice speaker preset (`cache/voice-preset-default.bin`)
  // is a mandatory bundle artifact — `EngineVoiceBridge.start()` hard-fails
  // without it (AGENTS.md §4 / inference/AGENTS.md §2). It must be listed in
  // `files.cache` so the downloader fetches it, and when the manifest declares
  // a `voice` block its `cache.speakerPreset` must point at the same path.
  if (!m.files.cache.some((f) => f.path === VOICE_PRESET_CACHE_PATH)) {
    errors.push(`files.cache: missing required ${VOICE_PRESET_CACHE_PATH}`);
  }
  if (m.voice && m.voice.cache.speakerPreset !== VOICE_PRESET_CACHE_PATH) {
    errors.push(
      `voice.cache.speakerPreset: must be ${VOICE_PRESET_CACHE_PATH}, got ${m.voice.cache.speakerPreset}`,
    );
  }

  // Eval gates.
  if (!m.evals.textEval.passed) errors.push("evals.textEval.passed: false");
  if (!m.evals.voiceRtf.passed) errors.push("evals.voiceRtf.passed: false");
  if (!m.evals.e2eLoopOk) errors.push("evals.e2eLoopOk: false");
  if (!m.evals.thirtyTurnOk) errors.push("evals.thirtyTurnOk: false");

  // Optional component slots must be internally consistent: a shipped
  // component needs auditable lineage, and lineage may not point at a
  // component absent from the bundle. Components that affect runtime quality
  // also require their own publish gate to pass.
  if (m.defaultEligible) {
    if ((m.files.asr ?? []).length === 0) {
      errors.push(
        "files.asr: required for defaultEligible local voice bundles",
      );
    }
    if ((m.files.vad ?? []).length === 0) {
      errors.push(
        "files.vad: required for defaultEligible local voice bundles",
      );
    }
  }

  for (const slot of [
    "asr",
    "embedding",
    "vision",
    "vad",
    "wakeword",
  ] as const) {
    const files = m.files[slot] ?? [];
    const lineage = m.lineage[slot];
    if (files.length > 0 && !lineage) {
      errors.push(`lineage.${slot}: required when files.${slot} is non-empty`);
    }
    if (lineage && files.length === 0) {
      errors.push(`files.${slot}: required when lineage.${slot} is present`);
    }
  }

  if ((m.files.asr ?? []).length > 0) {
    if (!m.evals.asrWer) {
      errors.push("evals.asrWer: required when files.asr is non-empty");
    } else if (!m.evals.asrWer.passed) {
      errors.push("evals.asrWer.passed: false");
    }
  }
  if ((m.files.embedding ?? []).length > 0) {
    if (!m.evals.embedMteb) {
      errors.push(
        "evals.embedMteb: required when files.embedding is non-empty",
      );
    } else if (!m.evals.embedMteb.passed) {
      errors.push("evals.embedMteb.passed: false");
    }
  }
  if ((m.files.vad ?? []).length > 0) {
    if (!m.evals.vadLatencyMs) {
      errors.push("evals.vadLatencyMs: required when files.vad is non-empty");
    } else if (!m.evals.vadLatencyMs.passed) {
      errors.push("evals.vadLatencyMs.passed: false");
    }
  }
  const expressiveVoice =
    m.voice?.capabilities.includes("emotion-tags") ||
    m.voice?.capabilities.includes("singing");
  if (expressiveVoice) {
    if (!m.evals.expressive) {
      errors.push(
        "evals.expressive: required when voice capabilities include emotion-tags or singing",
      );
    } else if (!m.evals.expressive.passed) {
      errors.push("evals.expressive.passed: false");
    }
  }

  // base-v1 provenance coverage. A `base-v1` manifest (the upstream base
  // models, GGUF-converted + fully optimized, NOT fine-tuned) MUST record
  // where every shipped component comes from — that is the whole point of
  // the release state.
  if (m.provenance) {
    if (
      m.provenance.releaseState === "base-v1" &&
      m.provenance.finetuned !== false
    ) {
      errors.push(
        "provenance.finetuned: must be false for releaseState=base-v1",
      );
    }
    if (m.provenance.releaseState === "base-v1") {
      const requiredSlots: Array<keyof typeof m.provenance.sourceModels> = [
        "text",
        "voice",
        "drafter",
      ];
      for (const slot of ["asr", "vad", "embedding", "vision"] as const) {
        if ((m.files[slot] ?? []).length > 0) requiredSlots.push(slot);
      }
      for (const slot of requiredSlots) {
        if (!m.provenance.sourceModels[slot]) {
          errors.push(
            `provenance.sourceModels.${slot}: required for releaseState=base-v1 (component is in files.${slot})`,
          );
        }
      }
    }
  }

  // DFlash bench. Staging manifests may record missing or failing DFlash
  // measurements, but a default bundle is not eligible unless speculative
  // decoding was actually measured and passed.
  if (!m.evals.dflash) {
    if (m.defaultEligible) {
      errors.push("evals.dflash: required when defaultEligible=true");
    }
  } else {
    if (
      m.evals.dflash.passed &&
      (m.evals.dflash.acceptanceRate === null ||
        m.evals.dflash.speedup === null)
    ) {
      errors.push(
        "evals.dflash: passed=true but acceptanceRate/speedup is null — a needs-hardware bench cannot pass",
      );
    }
    if (m.defaultEligible) {
      if (!m.evals.dflash.passed) {
        errors.push("evals.dflash.passed: false for defaultEligible manifest");
      }
      if (
        m.evals.dflash.acceptanceRate === null ||
        m.evals.dflash.speedup === null
      ) {
        errors.push(
          "evals.dflash: defaultEligible requires measured acceptanceRate and speedup",
        );
      }
    }
  }

  // The strongest claim: defaultEligible. If anything above failed, this
  // flag must be false. (Contract errors are already accumulated; we add
  // an explicit message so callers can identify the violation cleanly.)
  if (m.defaultEligible && errors.length > 0) {
    errors.unshift(
      "defaultEligible: true requires all required kernels, supported backends, and evals to pass",
    );
  }

  return errors;
}

/**
 * Convenience: list missing required kernels for a tier without doing
 * full validation. Used by the recommendation engine when surfacing
 * "this bundle is broken" diagnostics.
 */
export function missingRequiredKernels(
  tier: Eliza1Tier,
  declaredRequired: ReadonlyArray<Eliza1Kernel>,
): ReadonlyArray<Eliza1Kernel> {
  const declared = new Set(declaredRequired);
  return REQUIRED_KERNELS_BY_TIER[tier].filter((k) => !declared.has(k));
}
