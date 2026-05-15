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
  | "turn-detector-intl"
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
  | "q3_k_m"
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

/**
 * Runtime backend label for a voice model version.
 * - `"ggml"` — the elizaOS llama.cpp fork (canonical single-runtime policy).
 * - `"onnx"` — onnxruntime-node (one-release deprecation runway only; do not add new models here).
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
   * `"llama-server"` / `"ffi"` as each model migrates off ONNX. Assets with
   * `quant: "onnx-*"` that are NOT the preferred backend are on the
   * one-release deprecation runway.
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
    id: "turn-detector-intl",
    version: "0.1.0",
    publishedToHfAt: "2026-05-15T11:15:08Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "e7ef6204cbede995cc1ff740ed448ce1b6fe93d2",
    // K7: GGUF path live via LiveKitGgmlTurnDetector (J1.d). ONNX file
    // stays on HF for one release per HF asset policy.
    preferredBackend: "ggml",
    deprecatedBackends: ["onnx"],
    ggufAssets: [
      {
        filename: "voice/turn/intl/model_q8.onnx",
        sha256:
          "af70f5b5e815f6baf11dad252fbc80400964c6589cea02115187139f6ccf9d66",
        sizeBytes: 262031196,
        quant: "onnx-int8",
      },
      {
        filename: "voice/turn/intl/turn-detector-intl-q8.gguf",
        sha256:
          "5dbcba3fb490217b10ec898003dd0905f9d81b8b7e24378029cff921ab7f9e79",
        sizeBytes: 281016768,
        quant: "q8_0",
      },
    ],
    evalDeltas: { f1Delta: 0.09, netImprovement: true },
    changelogEntry:
      "LiveKit v0.4.1-intl fine-tuned on multilingual EOU (OASST1 12-lang prompter, prefix-augmented), APOLLO-Mini, F1=0.9308",
    minBundleVersion: "0.0.0",
  },
  {
    id: "turn-detector",
    version: "0.2.0",
    parentVersion: "0.1.0",
    publishedToHfAt: "2026-05-15T05:17:55Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    // K7: GGUF path live via LiveKitGgmlTurnDetector (J1.d). ONNX file
    // stays on HF for one release per HF asset policy.
    preferredBackend: "ggml",
    deprecatedBackends: ["onnx"],
    ggufAssets: [
      {
        filename: "voice/turn-detector/onnx/model_q8.onnx",
        sha256:
          "52a132ed9c53fe41381cd97a800a9d36b7494d5ea608183de03adfc0723662f8",
        sizeBytes: 37736316,
        quant: "onnx-int8",
      },
      {
        filename: "voice/turn-detector/onnx/turn-detector-en-q8.gguf",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    // K7: OmniVoice is fully on the fork via libelizainference FFI (W3-3).
    // No ONNX path ever existed for OmniVoice.
    preferredBackend: "llama-server",
    ggufAssets: [
      {
        filename: "voice/omnivoice/omnivoice-base-q4_k_m.gguf",
        sha256:
          "4836ba5affcb83c04d08b3e96b6e48ac839947ee3864188739807b68e0e159c6",
        sizeBytes: 407_485_216,
        quant: "q4_k_m",
      },
      {
        filename: "voice/omnivoice/omnivoice-tokenizer-q4_k_m.gguf",
        sha256:
          "988fc32bc699bce361c44e9af8383be9811960441f293eb5ab4ec6bf6386378d",
        sizeBytes: 252_474_112,
        quant: "q4_k_m",
      },
      {
        filename: "voice/omnivoice/omnivoice-base-q8_0.gguf",
        sha256:
          "2882d887921798aea13d45236556bdf8012842ab6f8cd2690943eead6289f298",
        sizeBytes: 656_395_008,
        quant: "q8_0",
      },
      {
        filename: "voice/omnivoice/presets/voice-preset-same.bin",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [
      {
        filename: "voice/speaker-encoder/wespeaker-resnet34-lm.onnx",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [
      {
        filename: "voice/diarizer/pyannote-segmentation-3.0-int8.onnx",
        sha256:
          "465d0975bf70fbf14fb77c0589a5d346a9c07c2170345f529cf774678446db76",
        sizeBytes: 1_542_304,
        quant: "onnx-int8",
      },
      {
        filename: "voice/diarizer/pyannote-segmentation-3.0-fp32.onnx",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [
      {
        filename: "voice/turn-detector/turn-detector-en-int8.onnx",
        sha256:
          "fdd695a99bda01155fb0b5ce71d34cb9fd3902c62496db7a6c2c7bdeac310ac7",
        sizeBytes: 65_712_276,
        quant: "onnx-int8",
      },
      {
        filename: "voice/turn-detector/turn-detector-intl-int8.onnx",
        sha256:
          "bd2c30776882138a1d95a07faddc13756fe1a35bef6323505f1124fca349bc9c",
        sizeBytes: 396_316_457,
        quant: "onnx-int8",
      },
      {
        filename: "voice/turn-detector/turnsense-fallback-int8.onnx",
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
    version: "0.2.0",
    publishedToHfAt: "2026-05-15T07:20:39Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [
      {
        filename: "voice/voice-emotion/wav2small-cls7-int8.onnx",
        sha256:
          "cba2c4e49707ac20da8b1420814b80735f700e917905c46d8cb880b95d97c953",
        sizeBytes: 524_750,
        quant: "onnx-int8",
      },
      {
        filename: "voice/voice-emotion/wav2small-msp-dim-int8.onnx",
        sha256:
          "2fcde4aa2a6881b0e7407a3a706fab1889b69233139ee10b8669795b02b06efc",
        sizeBytes: 516_877,
        quant: "onnx-int8",
      },
      {
        filename: "voice/voice-emotion/wav2small-msp-dim-fp32.onnx",
        sha256:
          "3f5a8bf8f035132798b170c57ab61b90d52bb0cb0dd1ef95fd40a97f466f65f7",
        sizeBytes: 1_211_917,
        quant: "onnx-fp32",
      },
      {
        filename: "voice/voice-emotion/wav2small-msp-dim-fp32.onnx.data",
        sha256:
          "5a3a84e879c786317570b551ee6240294c8deded27856a52d872c03b12c63d01",
        sizeBytes: 989_472,
        quant: "onnx-fp32",
      },
    ],
    evalDeltas: { f1Delta: 0.0042, netImprovement: true },
    changelogEntry:
      "v0.2.0 — Wav2Small cls7 head shipped (macro-F1=0.355 > 0.35 gate). V-A-D projection metric on the legacy vad head capped at 0.319 due to the teacher's compressed V-A-D distribution; runtime now auto-detects the head contract by ONNX output dim.",
    minBundleVersion: "0.0.0",
  },
  {
    // J2 (2026-05-15): Kokoro GGUF asset for the fork-side inference path.
    // The fork's `tools/kokoro/` subtree implements a standalone StyleTTS-2
    // + iSTFTNet inference pipeline (LLM_ARCH_KOKORO arch + GGML graph +
    // CPU iSTFT vocoder). The runtime selector (`pickKokoroRuntimeBackend`)
    // defaults `KOKORO_BACKEND=fork` and POSTs to llama-server's
    // /v1/audio/speech route; ONNX path remains as one-release deprecation.
    //
    // Quality gap: the from-scratch port runs at lower acoustic quality
    // vs the ONNX baseline (the predictor convs + ResBlock decoder need
    // a follow-up per-tensor weight-mapping pass). Documented in
    // .swarm/impl/J2-kokoro-port-notes.md; ship continues per brief override.
    //
    // missingAssets carries the planned ladder; the GGUF push to the
    // consolidated elizaos/eliza-1 repo lands once the full PyTorch
    // checkpoint walks through convert_kokoro_pth_to_gguf.py with the full
    // _PTH_KEY_RULES map (Q3..Q8 ladder via gguf_kokoro_apply.py from W3-1).
    id: "kokoro",
    version: "0.3.0",
    parentVersion: "0.2.0",
    publishedToHfAt: "2026-05-15T05:00:00Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "4b8809b197aa90ae486f83c1e0a5dc7effb6b285",
    // K7: runtime defaults to KOKORO_BACKEND=fork (pick-runtime.ts). ONNX
    // path is one-release deprecation runway (KOKORO_BACKEND=onnx env only).
    // GGUF conversion pending (K4 scope; missingAssets carries the target).
    preferredBackend: "llama-server",
    deprecatedBackends: ["onnx"],
    ggufAssets: [
      {
        filename: "voice/kokoro/voices/af_sam.bin",
        sha256:
          "6874670865ce984a5400afc87176706c5ed88671999c59ed0dff5dcde664277b",
        sizeBytes: 522_240,
        quant: "fp16",
      },
    ],
    missingAssets: [
      {
        filename: "voice/kokoro/kokoro-v1.0-q4_k_m.gguf",
        quant: "q4_k_m",
        expectedSizeBytes: 60_000_000,
        reason: "missing-from-local-staging",
      },
    ],
    evalDeltas: {
      // Same af_sam embedding ships as in 0.2.0. The version bump tracks
      // the runtime path move (ONNX → fork llama-server) not an embedding
      // change. netImprovement=false until the acoustic-quality gap closes.
      netImprovement: false,
    },
    changelogEntry:
      "0.3.0 — J2: fork-side Kokoro inference path (LLM_ARCH_KOKORO graph + tools/kokoro/). Runtime selector defaults to KOKORO_BACKEND=fork → llama-server /v1/audio/speech. ONNX path retained for one release. Quality gap vs ONNX baseline documented; compute-gated follow-up for full per-tensor weight mapping.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "kokoro",
    version: "0.2.0",
    parentVersion: "0.1.0",
    publishedToHfAt: "2026-05-15T11:27:44Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "e7ef6204cbede995cc1ff740ed448ce1b6fe93d2",
    ggufAssets: [
      {
        // af_sam — mel-fit voice clone anchor=0.2; shipped per user override.
        // evalGatePass=false: WER=1.0, UTMOS=2.32, SpkSim=0.15 (all fail gates).
        // Production sam voice is OmniVoice preset; this is Kokoro experimental slot.
        filename: "voice/kokoro/voices/af_sam.bin",
        sha256:
          "6874670865ce984a5400afc87176706c5ed88671999c59ed0dff5dcde664277b",
        sizeBytes: 522_240,
        quant: "fp16",
      },
    ],
    evalDeltas: {
      // Negative delta vs baseline af_bella: UTMOS -1.88, WER +1.0, SpkSim +0.23.
      // netImprovement=false — quality regression. Auto-updater will not recommend swap.
      mosDelta: -1.88,
      werDelta: 1.0,
      netImprovement: false,
    },
    changelogEntry:
      "0.2.0 — af_sam shipped per user override (I2); eval WER=1.0/UTMOS=2.32/SpkSim=0.15, gate=FAIL. OmniVoice preset remains production sam voice. compute-gated: needs ≥3h corpus for real quality.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "kokoro",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [
      {
        filename: "voice/kokoro/kokoro-v1.0-q4.onnx",
        sha256:
          "04cf570cf9c4153694f76347ed4b9a48c1b59ff1de0999e6605d123966b197c7",
        sizeBytes: 305_215_966,
        quant: "onnx-int8",
      },
      {
        filename: "voice/kokoro/voices/af_bella.bin",
        sha256:
          "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b",
        sizeBytes: 522_240,
        quant: "fp16",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry:
      "Initial release — kokoro 82M voice-embedding af_bella preset.",
    minBundleVersion: "0.0.0",
  },
  {
    id: "omnivoice",
    version: "0.1.0",
    publishedToHfAt: "2026-05-14T00:00:00Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [],
    missingAssets: [
      {
        filename: "voice/omnivoice/omnivoice-base-q4_k_m.gguf",
        quant: "q4_k_m",
        expectedSizeBytes: 388_000_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "voice/omnivoice/omnivoice-tokenizer-q4_k_m.gguf",
        quant: "q4_k_m",
        expectedSizeBytes: 51_200_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "voice/omnivoice/omnivoice-base-q8_0.gguf",
        quant: "q8_0",
        expectedSizeBytes: 620_000_000,
        reason: "missing-from-local-staging",
      },
      {
        filename: "voice/omnivoice/presets/voice-preset-same.bin",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    // K7: VAD is fully on fork FFI (eliza_inference_vad_* in libelizainference).
    // vad.ts imports SileroVadGgml only; onnxruntime-node NOT imported.
    // ONNX file stays on HF for one release per HF asset policy.
    preferredBackend: "ffi",
    deprecatedBackends: ["onnx"],
    ggufAssets: [
      {
        filename: "voice/vad/silero-vad-int8.onnx",
        sha256:
          "90b026c95f054d59d7bf79387b0ed93c8950f35a4d8b741cd78d4bb23a7d2776",
        sizeBytes: 639_383,
        quant: "onnx-int8",
      },
      {
        filename: "voice/vad/silero-vad-v5.1.2.ggml.bin",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    // K7: wake-word is fully on fork FFI (eliza_inference_wakeword_* in
    // libelizainference). wake-word.ts uses GgmlWakeWordModel only;
    // onnxruntime-node NOT imported. ONNX files stay on HF for one release.
    preferredBackend: "ffi",
    deprecatedBackends: ["onnx"],
    ggufAssets: [
      {
        filename: "voice/wakeword/melspectrogram.onnx",
        sha256:
          "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
        sizeBytes: 1_087_958,
        quant: "onnx-fp32",
      },
      {
        filename: "voice/wakeword/embedding_model.onnx",
        sha256:
          "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
        sizeBytes: 1_326_578,
        quant: "onnx-fp32",
      },
      {
        filename: "voice/wakeword/hey-eliza-int8.onnx",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [
      {
        filename: "voice/embedding/eliza-1-embedding-q8_0.gguf",
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
    hfRepo: "elizaos/eliza-1",
    hfRevision: "20b291b5820937e8a1e1ca9f2927f5bc64aefe7e",
    ggufAssets: [
      {
        filename: "voice/asr/eliza-1-asr-q8_0.gguf",
        sha256:
          "58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57",
        sizeBytes: 2_165_034_944,
        quant: "q8_0",
      },
      {
        filename: "voice/asr/eliza-1-asr-mmproj.gguf",
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
  {
    id: "asr",
    version: "0.2.0",
    publishedToHfAt: "2026-05-15T00:00:00Z",
    hfRepo: "elizaos/eliza-1",
    hfRevision: "50cffb075ae3c24a4b0cd3a8ccdfaa92506f70d4",
    ggufAssets: [
      {
        filename: "voice/asr/eliza-1-asr-q3_k_m.gguf",
        sha256:
          "80c046bf44cf52699bcef0f5a10d9774a0415c127432a0d0f428e6f1634d7f12",
        sizeBytes: 1_073_237_952,
        quant: "q3_k_m",
      },
      {
        filename: "voice/asr/eliza-1-asr-q4_k_m.gguf",
        sha256:
          "de11f7110e6faddc277088262cffe8adc3228220a1cfd133c49420bb8bd3c3c5",
        sizeBytes: 1_282_435_008,
        quant: "q4_k_m",
      },
      {
        filename: "voice/asr/eliza-1-asr-q5_k_m.gguf",
        sha256:
          "dcffc861bc968202a6ca1107f3335c3dfcd89d6945ca87569596d6a9f551207a",
        sizeBytes: 1_471_801_280,
        quant: "q5_k_m",
      },
      {
        filename: "voice/asr/eliza-1-asr-q6_k.gguf",
        sha256:
          "b0f6f2d610dfcc95c4147271855d1aadf78d298d193666834912eb600c5eaf0b",
        sizeBytes: 1_673_002_944,
        quant: "q6_k",
      },
      {
        filename: "voice/asr/eliza-1-asr-mmproj.gguf",
        sha256:
          "46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d",
        sizeBytes: 355_709_344,
        quant: "q8_0",
      },
    ],
    evalDeltas: { netImprovement: true },
    changelogEntry:
      "K-quant ladder: Q3_K_M, Q4_K_M, Q5_K_M, Q6_K added for Qwen3-ASR-1.7B. Enables memory-tier selection. mmproj stays Q8_0 per R8 §3.6.",
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
