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
    id: "turn-detector",
    version: "0.2.0",
    parentVersion: "0.1.0",
    publishedToHfAt: "2026-05-15T05:17:55Z",
    hfRepo: "elizaos/eliza-1-voice-turn",
    hfRevision: "9eaff4947ebd87b1d811e27dec939e29362a9e42",
    ggufAssets: [
      {
        filename: "onnx/model_q8.onnx",
        sha256:
          "52a132ed9c53fe41381cd97a800a9d36b7494d5ea608183de03adfc0723662f8",
        sizeBytes: 37736316,
        quant: "onnx-int8",
      },
      {
        filename: "onnx/turn-detector-en-q8.gguf",
        sha256:
          "04bc18aeec5f59a94ae338aa66a48e204fc02785a6217d9055145f95d2192980",
        sizeBytes: 41275296,
        quant: "q8_0",
      },
    ],
    evalDeltas: { f1Delta: 0.1411, netImprovement: true },
    changelogEntry:
      "LiveKit v1.2.2-en fine-tuned on DailyDialog (prefix-augmented EOU corpus, APOLLO-Mini, F1=0.9811 vs 0.84 baseline)",
    minBundleVersion: "0.0.0",
  },
  {
    id: "omnivoice",
    version: "0.2.0",
    parentVersion: "0.1.0",
    publishedToHfAt: "2026-05-15T04:50:24Z",
    hfRepo: "elizaos/eliza-1-voice-omnivoice",
    hfRevision: "b766eb23d5f6c84d580973c0f2013b6fcbd561c0",
    ggufAssets: [
      {
        filename: "omnivoice-base-q4_k_m.gguf",
        sha256:
          "4836ba5affcb83c04d08b3e96b6e48ac839947ee3864188739807b68e0e159c6",
        sizeBytes: 407_485_216,
        quant: "q4_k_m",
      },
      {
        filename: "omnivoice-tokenizer-q4_k_m.gguf",
        sha256:
          "988fc32bc699bce361c44e9af8383be9811960441f293eb5ab4ec6bf6386378d",
        sizeBytes: 252_474_112,
        quant: "q4_k_m",
      },
      {
        filename: "omnivoice-base-q8_0.gguf",
        sha256:
          "2882d887921798aea13d45236556bdf8012842ab6f8cd2690943eead6289f298",
        sizeBytes: 656_395_008,
        quant: "q8_0",
      },
      {
        filename: "presets/voice-preset-same.bin",
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
    publishedToHfAt: "2026-05-15T07:15:30Z",
    hfRepo: "elizaos/eliza-1-voice-speaker",
    hfRevision: "3d882d6dfb00c9eed49f89bb7cc2e45ac3497159",
    ggufAssets: [
      {
        filename: "wespeaker-resnet34-lm.onnx",
        sha256:
          "7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068",
        sizeBytes: 26_530_309,
        quant: "onnx-fp16",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — WeSpeaker ResNet34-LM 256-dim int8.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "diarizer",
    version: "0.1.0",
    publishedToHfAt: "2026-05-15T07:15:30Z",
    hfRepo: "elizaos/eliza-1-voice-diarizer",
    hfRevision: "7a8d059b770aeab08e6eabcf9dcbfc051e5bafef",
    ggufAssets: [
      {
        filename: "pyannote-segmentation-3.0-int8.onnx",
        sha256:
          "465d0975bf70fbf14fb77c0589a5d346a9c07c2170345f529cf774678446db76",
        sizeBytes: 1_542_304,
        quant: "onnx-int8",
      },
      {
        filename: "pyannote-segmentation-3.0-fp32.onnx",
        sha256:
          "057ee564753071c0b09b5b611648b50ac188d50846bff5f01e9f7bbf1591ea25",
        sizeBytes: 5_986_908,
        quant: "onnx-fp16",
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
    hfRevision: "6fb5a2ef8942c857904d78ca10ab91a22dba1e06",
    ggufAssets: [
      {
        filename: "turn-detector-en-int8.onnx",
        sha256:
          "fdd695a99bda01155fb0b5ce71d34cb9fd3902c62496db7a6c2c7bdeac310ac7",
        sizeBytes: 65_712_276,
        quant: "onnx-int8",
      },
      {
        filename: "turn-detector-intl-int8.onnx",
        sha256:
          "bd2c30776882138a1d95a07faddc13756fe1a35bef6323505f1124fca349bc9c",
        sizeBytes: 396_316_457,
        quant: "onnx-int8",
      },
      {
        filename: "turnsense-fallback-int8.onnx",
        sha256:
          "a423adf55f5f33cf4ee9e3fe73ec133d0106affae3aa14693417b4a1c79e2df8",
        sizeBytes: 176_072_860,
        quant: "onnx-int8",
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
    hfRevision: "da50fd9719dd78857829b144d6f72ce3c4e3464a",
    ggufAssets: [
      {
        filename: "wav2small-msp-dim-int8.onnx",
        sha256:
          "2fcde4aa2a6881b0e7407a3a706fab1889b69233139ee10b8669795b02b06efc",
        sizeBytes: 516_877,
        quant: "onnx-int8",
      },
      {
        filename: "wav2small-msp-dim-fp32.onnx",
        sha256:
          "3f5a8bf8f035132798b170c57ab61b90d52bb0cb0dd1ef95fd40a97f466f65f7",
        sizeBytes: 1_211_917,
        quant: "onnx-fp32",
      },
      {
        filename: "wav2small-msp-dim-fp32.onnx.data",
        sha256:
          "5a3a84e879c786317570b551ee6240294c8deded27856a52d872c03b12c63d01",
        sizeBytes: 989_472,
        quant: "onnx-fp32",
      },
    ],
    evalDeltas: { f1Delta: -0.0308, netImprovement: false },
    changelogEntry:
      "Initial release — Wav2Small acoustic V-A-D classifier staged with evalGatePass=false for projection macro-F1; auxiliary head macro-F1=0.355.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "kokoro",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1-voice-kokoro",
    hfRevision: "967f7449f79414d2b49db3b2441ea683630c11ab",
    ggufAssets: [
      {
        filename: "kokoro-v1.0-q4.onnx",
        sha256:
          "04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7",
        sizeBytes: 305_215_966,
        quant: "onnx-int8",
      },
      {
        filename: "voices/af_bella.bin",
        sha256:
          "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b",
        sizeBytes: 522_240,
        quant: "fp16",
      },
      {
        filename: "voices/af_same.bin",
        sha256:
          "cf2810d3eb73cdcff22e285b0c51711773acb99b6d7606656f3c63ee414c628e",
        sizeBytes: 522_240,
        quant: "fp16",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — kokoro 82M voice-embedding same clone.",
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
        filename: "presets/voice-preset-same.bin",
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
    publishedToHfAt: "2026-05-15T07:15:30Z",
    hfRepo: "elizaos/eliza-1-voice-vad",
    hfRevision: "7fc2359bbc0ee1e0dd7de2acb126f6872a4fb4c2",
    ggufAssets: [
      {
        filename: "silero-vad-int8.onnx",
        sha256:
          "90b026c95f054d59d7bf79387b0ed93c8950f35a4d8b741cd78d4bb23a7d2776",
        sizeBytes: 639_383,
        quant: "onnx-int8",
      },
      {
        filename: "silero-vad-v5.1.2.ggml.bin",
        sha256:
          "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
        sizeBytes: 885_098,
        quant: "onnx-fp16",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — Silero VAD v5.1.2.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "wakeword",
    version: "0.1.0",
    publishedToHfAt: "2026-05-15T07:15:30Z",
    hfRepo: "elizaos/eliza-1-voice-wakeword",
    hfRevision: "bcd866bc070a649dfd2dfbf7aadbd01b3cc68c4b",
    ggufAssets: [
      {
        filename: "melspectrogram.onnx",
        sha256:
          "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
        sizeBytes: 1_087_958,
        quant: "onnx-fp32",
      },
      {
        filename: "embedding_model.onnx",
        sha256:
          "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
        sizeBytes: 1_326_578,
        quant: "onnx-fp32",
      },
      {
        filename: "hey-eliza-int8.onnx",
        sha256:
          "e565952901cd4203baacef7cb8700891c9bee4e6f42fc9bc0aa03b9c39a2da92",
        sizeBytes: 630_032,
        quant: "onnx-int8",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — hey-eliza wake-word head.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "embedding",
    version: "0.1.0",
    publishedToHfAt: "2026-05-15T07:15:30Z",
    hfRepo: "elizaos/eliza-1-voice-embedding",
    hfRevision: "bf6afa907c83ec98e487f018cfb4e29ec3cb7c03",
    ggufAssets: [
      {
        filename: "eliza-1-embedding-q8_0.gguf",
        sha256:
          "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
        sizeBytes: 639_150_592,
        quant: "q8_0",
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
    hfRevision: "c5b2f3b358fb0b0c0713d7290e2eed61b0fb174f",
    ggufAssets: [
      {
        filename: "eliza-1-asr-q8_0.gguf",
        sha256:
          "58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57",
        sizeBytes: 2_165_034_944,
        quant: "q8_0",
      },
      {
        filename: "eliza-1-asr-mmproj.gguf",
        sha256:
          "46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d",
        sizeBytes: 355_709_344,
        quant: "q8_0",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry: "Initial release — Qwen3-ASR streaming transcriber Q8_0.",
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
