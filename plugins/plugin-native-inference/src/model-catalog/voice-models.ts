import versionData from "./voice-model-versions.json" with { type: "json" };

/**
 * Sub-model versioning for voice components.
 *
 * The bundle manifest (`eliza-1.manifest.json`) ships the *current* set of
 * files for one tier. This module ships the *history*: every voice
 * sub-model id we publish, every semver version, the parent it succeeds,
 * the per-version eval deltas vs. that parent, the GGUF assets, and the
 * minimum bundle version each voice version is compatible with.
 *
 * The publish pipeline writes both this file AND the matching H3 in
 * the sibling `voice-models/CHANGELOG.md`. The publish gate refuses to
 * land one without the other. The runtime auto-update checker reads
 * only this file.
 *
 * Spec: `.swarm/research/R5-versioning.md` §2.
 */

/**
 * Stable id for each voice sub-model. Never reused across architectures —
 * if we rip out `voice-emotion` (Wav2Small) for a different classifier
 * later, give it a new id rather than incrementing the version.
 *
 * Aligned with `Eliza1FilesSchema` keys where applicable and with the
 * I1/I2/I3/I6/I7 implementations.
 */
export type VoiceModelId =
  | "speaker-encoder"
  | "diarizer"
  | "turn-detector"
  | "turn-detector-intl"
  | "voice-emotion"
  | "kokoro"
  | "vad"
  | "wakeword"
  | "embedding"
  | "asr";

/**
 * Quant labels mirror `CatalogQuantizationVariant` ids used by the text
 * GGUF catalog. ONNX-only voice models use a sentinel `onnx-*` quant tag.
 */
export type VoiceModelQuant =
  | "q3_k_m"
  | "q4_0"
  | "q4_k_m"
  | "q5_k_m"
  | "q6_k"
  | "q8_0"
  | "gguf-fp32"
  | "fp16"
  | "onnx-fp32"
  | "onnx-fp16"
  | "onnx-int8";

export interface VoiceModelGgufAsset {
  /** Filename inside `hfRepo` at `hfRevision`. */
  readonly filename: string;
  /** SHA256 of the file at this revision, 64 lowercase hex chars. */
  readonly sha256: string;
  /** Bytes — used to gate downloads on cellular/metered links. */
  readonly sizeBytes: number;
  /** Quantization label. */
  readonly quant: VoiceModelQuant;
}

export type VoiceModelMissingAssetReason =
  | "missing-from-local-staging"
  | "missing-from-hf-repo";

export interface VoiceModelMissingAsset {
  /** Expected filename inside `hfRepo` at `hfRevision`. */
  readonly filename: string;
  /** Expected quantization label. */
  readonly quant: VoiceModelQuant;
  /** Approximate planned bytes from the staging manifest; not a verified size. */
  readonly expectedSizeBytes?: number;
  /** Why no sha256/sizeBytes are recorded in `ggufAssets`. */
  readonly reason: VoiceModelMissingAssetReason;
}

/**
 * Per-metric improvement vs the parent version. Sign conventions:
 *
 * - Negative-direction metrics (lower is better): `rtfDelta`, `werDelta`,
 *   `eerDelta`, `falseBargeInDelta`. Negative deltas are improvements.
 * - Positive-direction metrics (higher is better): `f1Delta`, `mosDelta`.
 *   Positive deltas are improvements.
 *
 * The `netImprovement` flag is the audit trail set by the publish gate;
 * the auto-updater requires `netImprovement === true` before it will
 * recommend an automatic swap (see `shouldAutoUpdate` in
 * `voice-model-updater.ts`).
 */
export interface VoiceModelEvalDeltas {
  /** RTF improvement vs parentVersion, negative = faster. */
  readonly rtfDelta?: number;
  /** WER improvement vs parentVersion, negative = better. */
  readonly werDelta?: number;
  /** Equal-error-rate delta for speaker encoder; negative = better. */
  readonly eerDelta?: number;
  /** F1 delta for turn detector / emotion classifier; positive = better. */
  readonly f1Delta?: number;
  /** MOS / MOS-expressive delta for TTS; positive = better. */
  readonly mosDelta?: number;
  /** False-barge-in-rate delta for VAD; negative = better. */
  readonly falseBargeInDelta?: number;
  /**
   * Overall improvement flag set by the publish gate from per-metric
   * thresholds. Auto-update is gated on `netImprovement === true`.
   * For initial releases (parentVersion absent), this is `true` if the
   * model met its standalone publish thresholds.
   */
  readonly netImprovement: boolean;
}

/**
 * Runtime backend label for a voice model version.
 * - `"ggml"` — the elizaOS llama.cpp fork (canonical single-runtime policy).
 * - `"onnx"` — onnxruntime-node (removed; retained only as a historical asset/label for already-published versions — do not add new models here).
 * - `"ffi"` — direct bun:ffi into libelizainference (VAD, wake-word).
 * - `"llama-server"` — fork's llama-server HTTP route (Kokoro, OmniVoice TTS, EOT text model).
 */
export type VoiceModelBackend = "ggml" | "onnx" | "ffi" | "llama-server";

export interface VoiceModelVersion {
  /** Stable id. */
  readonly id: VoiceModelId;
  /** Semver (e.g. "0.1.0", "1.2.0-rc.3"). */
  readonly version: string;
  /** Direct semver predecessor; absent on the initial release. */
  readonly parentVersion?: string;
  /** ISO timestamp of HF publish. */
  readonly publishedToHfAt: string;
  /** HuggingFace repo (`owner/name`) holding this version's assets. */
  readonly hfRepo: string;
  /** Git revision (commit SHA or tag) of the HF repo at publish time. */
  readonly hfRevision: string;
  /**
   * Preferred runtime backend for this version. When set, the runtime
   * prefers the named backend over any default. K7 policy: set to `"ggml"` /
   * `"llama-server"` / `"ffi"` as each model migrated off ONNX. onnxruntime-node
   * has since been removed, so assets with `quant: "onnx-*"` are historical
   * labels only — the runtime never loads them.
   */
  readonly preferredBackend?: VoiceModelBackend;
  /**
   * Backends that are deprecated in this version and will be removed in the
   * next release. The download manager surfaces these to the user; the
   * runtime emits a deprecation warning when the deprecated backend is
   * selected explicitly via env override.
   */
  readonly deprecatedBackends?: ReadonlyArray<VoiceModelBackend>;
  /** Per-asset SHA256 + size + quant. */
  readonly ggufAssets: ReadonlyArray<VoiceModelGgufAsset>;
  /** Expected assets that were not available for sha256/size verification. */
  readonly missingAssets?: ReadonlyArray<VoiceModelMissingAsset>;
  /** Eval gates vs parentVersion (or baseline for initial releases). */
  readonly evalDeltas: VoiceModelEvalDeltas;
  /** First line of the matching H3 in the sibling `voice-models/CHANGELOG.md`. */
  readonly changelogEntry: string;
  /** Minimum `eliza1Manifest.version` this voice version is compatible with. */
  readonly minBundleVersion: string;
}

/**
 * Reverse-chronological history per model id. Index 0 is the latest.
 *
 * The publish pipeline prepends a new version; never edit a published
 * entry in place (sha + size are the audit trail).
 *
 * Asset hashes and revisions are pinned audit data. `missingAssets` records
 * unavailable upstream artifacts explicitly instead of using provisional
 * checksums.
 */
export const VOICE_MODEL_VERSIONS: ReadonlyArray<VoiceModelVersion> =
  versionData as VoiceModelVersion[];

/**
 * Strict semver compare. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Pre-release ids are compared lexically per semver 2.0.0 §11. Returns
 * null when either argument is not a valid semver.
 */
export function compareVoiceModelSemver(
  a: string,
  b: string,
): -1 | 0 | 1 | null {
  const parse = (
    s: string,
  ): { core: [number, number, number]; pre: ReadonlyArray<string> } | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?$/.exec(s);
    if (!m) return null;
    return {
      core: [Number(m[1]), Number(m[2]), Number(m[3])],
      pre: m[4] ? m[4].split(".") : [],
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] < pb.core[i] ? -1 : 1;
  }
  // Per semver 2.0.0 §11: a version with a pre-release tag has lower
  // precedence than the same version without.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai) ? Number(ai) : null;
    const bNum = /^\d+$/.test(bi) ? Number(bi) : null;
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum < bNum ? -1 : 1;
    } else if (aNum !== null) {
      return -1;
    } else if (bNum !== null) {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/**
 * The HuggingFace `resolve` URL for one GGUF asset of a voice-model version,
 * pinned to that version's exact `hfRevision`. This is the canonical download
 * URL the packaging-verification test and the runtime downloader both use, so
 * the catalog stays the single source of truth for where bytes come from.
 */
export function voiceModelAssetUrl(
  version: Pick<VoiceModelVersion, "hfRepo" | "hfRevision">,
  asset: Pick<VoiceModelGgufAsset, "filename">,
): string {
  return `https://huggingface.co/${version.hfRepo}/resolve/${version.hfRevision}/${asset.filename}`;
}

/** Return all versions for a given model id, latest first. */
export function versionsFor(
  id: VoiceModelId,
): ReadonlyArray<VoiceModelVersion> {
  return VOICE_MODEL_VERSIONS.filter((v) => v.id === id).sort((a, b) => {
    const cmp = compareVoiceModelSemver(a.version, b.version);
    if (cmp === null) return 0;
    return cmp === 1 ? -1 : cmp === -1 ? 1 : 0;
  });
}

/** Latest known version for the given id, or undefined if none. */
export function latestVoiceModelVersion(
  id: VoiceModelId,
): VoiceModelVersion | undefined {
  return versionsFor(id)[0];
}

/** Lookup by id + exact version. */
export function findVoiceModelVersion(
  id: VoiceModelId,
  version: string,
): VoiceModelVersion | undefined {
  return VOICE_MODEL_VERSIONS.find((v) => v.id === id && v.version === version);
}
