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
 * `models/voice/CHANGELOG.md`. The publish gate refuses to land one
 * without the other. The runtime auto-update checker reads only this file.
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
  | "voice-emotion"
  | "kokoro"
  | "omnivoice"
  | "vad"
  | "wakeword"
  | "embedding"
  | "asr";

/**
 * Quant labels mirror `CatalogQuantizationVariant` ids used by the text
 * GGUF catalog. ONNX-only voice models use a sentinel `onnx-*` quant tag.
 */
export type VoiceModelQuant =
  | "q4_0"
  | "q4_k_m"
  | "q5_k_m"
  | "q6_k"
  | "q8_0"
  | "fp16"
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
  /** Per-asset SHA256 + size + quant. */
  readonly ggufAssets: ReadonlyArray<VoiceModelGgufAsset>;
  /** Expected assets that were not available for sha256/size verification. */
  readonly missingAssets?: ReadonlyArray<VoiceModelMissingAsset>;
  /** Eval gates vs parentVersion (or baseline for initial releases). */
  readonly evalDeltas: VoiceModelEvalDeltas;
  /** First line of the matching H3 in `models/voice/CHANGELOG.md`. */
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
 * Initial release values: assets/revisions are placeholders until the I6
 * (omnivoice), I7 (kokoro), I1 (turn-detector), I2 (speaker-encoder +
 * diarizer), and I3 (voice-emotion) publish pipelines fill them in.
 */
export const VOICE_MODEL_VERSIONS: ReadonlyArray<VoiceModelVersion> = [
  {
    id: "omnivoice",
    version: "0.2.0",
    parentVersion: "0.1.0",
    publishedToHfAt: "2026-05-15T04:50:24Z",
    hfRepo: "elizaos/eliza-1-voice-omnivoice-same-v01",
    hfRevision: "fd0d04439d48826abc89dcfc03d9d1f31d29bf20",
    ggufAssets: [
      {
        filename: "voice-preset.elz2",
        sha256:
          "efb3ab57f6e3884a2414a9cf9dcdb77a66b61bb43713df9ff1632e7539191be6",
        sizeBytes: 716,
        quant: "fp16",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry:
      "OmniVoice ELZ2 v2 frozen-conditioning preset for the 'same' voice (Her-derivative)",
    minBundleVersion: "0.0.0",
  },
  {
    id: "speaker-encoder",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-speaker",
    hfRevision: "b73284e0cdb6ac439cac1885b8c14477e80ff96c",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "wespeaker-ecapa-tdnn-256-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 7_340_032,
        reason: "missing-from-local-staging",
      },
      {
        filename: "wespeaker-ecapa-tdnn-256-fp32.onnx",
        quant: "onnx-fp16",
        expectedSizeBytes: 26_214_400,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — WeSpeaker ResNet34-LM 256-dim int8.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "diarizer",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-diarizer",
    hfRevision: "d09b316ddf46297e1cda8079fa621ff39d101631",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "pyannote-segmentation-3.0-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 1_614_807,
        reason: "missing-from-local-staging",
      },
      {
        filename: "pyannote-segmentation-3.0-fp32.onnx",
        quant: "onnx-fp16",
        expectedSizeBytes: 6_291_456,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — Pyannote-segmentation-3.0 ONNX int8.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "turn-detector",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-turn",
    hfRevision: "69cec917d74dc5ddc27f34f3ab69cef3fc6fe732",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "turn-detector-en-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 65_700_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "turn-detector-intl-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 396_000_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "turnsense-fallback-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 8_000_000,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — LiveKit turn-detector (135M + intl).",
    minBundleVersion: "0.0.0",
  },
  {
    id: "voice-emotion",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-emotion",
    hfRevision: "edfeb4e5704c8ca13eccf01cc78324d9422824d0",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "wav2small-msp-dim-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 122_880,
        reason: "missing-from-local-staging",
      },
      {
        filename: "wav2small-msp-dim-fp32.onnx",
        quant: "onnx-fp16",
        expectedSizeBytes: 491_520,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — Wav2Small acoustic V-A-D classifier.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "kokoro",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-kokoro",
    hfRevision: "da4b5d73d4c1f8e37e86a4e0d51d7e4141e8f855",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "kokoro-v1.0-q4.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 326_144_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "voices/af_bella.bin",
        quant: "fp16",
        expectedSizeBytes: 524_288,
        reason: "missing-from-local-staging",
      },
      {
        filename: "voices/af_sam.bin",
        quant: "fp16",
        expectedSizeBytes: 524_288,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — kokoro 82M voice-embedding sam clone.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "omnivoice",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-omnivoice",
    hfRevision: "cc5e5d856fc5f05c1a01b787d3e8602d2f05ba9c",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "omnivoice-base-q4_k_m.gguf",
        quant: "q4_k_m",
        expectedSizeBytes: 388_000_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "omnivoice-tokenizer-q4_k_m.gguf",
        quant: "q4_k_m",
        expectedSizeBytes: 51_200_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "omnivoice-base-q8_0.gguf",
        quant: "q8_0",
        expectedSizeBytes: 620_000_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "presets/voice-preset-sam.bin",
        quant: "fp16",
        expectedSizeBytes: 8_192,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — OmniVoice frozen-conditioning sam.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "vad",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-vad",
    hfRevision: "feb778c5d13802f428f8846dcaea60318547e88d",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "silero-vad-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 1_056_768,
        reason: "missing-from-local-staging",
      },
      {
        filename: "silero-vad-v5.1.2.ggml.bin",
        quant: "onnx-fp16",
        expectedSizeBytes: 2_093_056,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — Silero VAD v5.1.2.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "wakeword",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-wakeword",
    hfRevision: "d6fe9bfb2b9dac99e7f7c79cfdc60025bfaab721",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "hey-eliza-int8.onnx",
        quant: "onnx-int8",
        expectedSizeBytes: 1_048_576,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — hey-eliza wake-word head.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "embedding",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-embedding",
    hfRevision: "eb96371b6d4b87eee6f84303408fd1603fa6cde2",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "eliza-1-embedding-q4_k_m.gguf",
        quant: "q4_k_m",
        expectedSizeBytes: 524_288_000,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — Eliza-1 BPE-vocab embedding tier.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "asr",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-asr",
    hfRevision: "0c1305f0618eb0a752f517a7cfd9ed65e42b760c",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "eliza-1-asr-q4_k_m.gguf",
        quant: "q4_k_m",
        expectedSizeBytes: 918_748_160,
        reason: "missing-from-local-staging",
      },
      {
        filename: "eliza-1-asr-mmproj.gguf",
        quant: "fp16",
        expectedSizeBytes: 52_428_800,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — Qwen3-ASR streaming transcriber Q4_K_M.",
    minBundleVersion: "0.0.0",
  },
];

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
