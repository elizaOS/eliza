/**
 * Eliza-curated local model catalog.
 *
 * Default local inference is restricted to the active Eliza-1 line:
 * eliza-1-2b, eliza-1-4b, eliza-1-9b, eliza-1-27b,
 * and eliza-1-27b-256k.
 * These ship Gemma 4 bases: E2B/E4B/12B/31B mapped onto the
 * 2B/4B/9B/27B release tiers (the 2026-06-22 cutover from the legacy
 * hybrid line — see #9033 and packages/training/scripts/training/model_registry.py
 * for the active registry). Gemma 4 is a dense SWA + shared-KV + per-layer-embedding
 * (PLE) + MQA architecture; KV is already minimal so the legacy
 * QJL/PolarQuant KV kernels are not used (stock KV), while TurboQuant
 * weight-quant remains active. External Hub search remains custom/opt-in and
 * never enters first-run or default eligibility.
 * Separate-drafter MTP is still the required release shape, but runtime
 * metadata is gated until the Gemma drafter GGUFs are actually hosted.
 */

import { resolveHfDownloadBase } from "./hf-proxy.js";
import type {
  CatalogModel,
  CatalogQuantizationId,
  CatalogQuantizationVariant,
  LocalRuntimeKernel,
} from "./types.js";

export const ELIZA_1_HF_REPO = "elizaos/eliza-1" as const;

export const ELIZA_1_TIER_IDS = [
  "eliza-1-2b",
  "eliza-1-4b",
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
] as const;

export type Eliza1TierId = (typeof ELIZA_1_TIER_IDS)[number];

export const ELIZA_1_RELEASE_TIER_IDS =
  ELIZA_1_TIER_IDS satisfies ReadonlyArray<Eliza1TierId>;

export const ELIZA_1_VISION_TIER_IDS = [
  "eliza-1-2b",
  "eliza-1-4b",
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
] as const satisfies ReadonlyArray<Eliza1TierId>;

const _ELIZA_1_VISION_TIER_ID_SET: ReadonlySet<Eliza1TierId> = new Set(
  ELIZA_1_VISION_TIER_IDS,
);

export const ELIZA_1_MTP_TIER_IDS = [
  "eliza-1-2b",
  "eliza-1-4b",
  "eliza-1-9b",
  "eliza-1-27b",
  "eliza-1-27b-256k",
] as const satisfies ReadonlyArray<Eliza1TierId>;

/**
 * Tiers whose Gemma MTP drafter GGUFs are present at
 * `bundles/<tier>/mtp/drafter-<tier>.gguf` in the active HF tree.
 *
 * Current HF state (2026-07-02): `bundles/2b/mtp/drafter-2b.gguf` hosts the
 * gemma4-assistant drafter converted from `google/gemma-4-E2B-it-assistant`
 * (arch `gemma4-assistant`, f16, embedding_length_out=1536; sha256
 * 0495d34e08d0…, manifest `files.mtp` + `lineage.drafter` + `evals.mtp`
 * populated — acceptance 0.84, speedup ~1.53x greedy on M4 Max Metal at
 * `--spec-draft-n-max 1`). `bundles/4b/mtp/drafter-4b.gguf` hosts the
 * drafter converted from `google/gemma-4-E4B-it-assistant` (arch
 * `gemma4-assistant`, f16, embedding_length_out=2560; sha256 e4585e558a74…,
 * manifest populated — acceptance 0.79, speedup ~1.33x greedy on M4 Max
 * Metal at `--spec-draft-n-max 1`). The remaining tiers (9b/27b) still only
 * expose legacy `dflash/` paths; add a tier here only once its
 * `mtp/drafter-<tier>.gguf` is actually hosted, so the runtime and
 * downloader never advertise or fetch missing MTP artifacts.
 */
export const ELIZA_1_HOSTED_MTP_TIER_IDS = [
  "eliza-1-2b",
  "eliza-1-4b",
] as const satisfies ReadonlyArray<Eliza1TierId>;

function hostedMtpDrafterAvailableForTier(id: Eliza1TierId): boolean {
  return ELIZA_1_HOSTED_MTP_TIER_IDS.some((mtpId) => mtpId === id);
}

/**
 * On-device (mobile-class) tiers. These are the tiers small enough to run on
 * a phone, so they advertise the Gemma-4 QAT `Q4_0` quant as the
 * mobile-preferred variant and ship a LiteRT `.litertlm` bundle for the
 * on-device LiteRT-LM runtime (NPU/GPU delegate). Mirrors the Kokoro-only
 * voice policy and the SD-1.5 image-gen tiering (2b/4b).
 */
export const ELIZA_1_ON_DEVICE_TIER_IDS = [
  "eliza-1-2b",
  "eliza-1-4b",
] as const satisfies ReadonlyArray<Eliza1TierId>;

const _ELIZA_1_ON_DEVICE_TIER_ID_SET: ReadonlySet<Eliza1TierId> = new Set(
  ELIZA_1_ON_DEVICE_TIER_IDS,
);

export function isOnDeviceTier(id: Eliza1TierId): boolean {
  return _ELIZA_1_ON_DEVICE_TIER_ID_SET.has(id);
}

// The quantized 2B (Gemma 4 E2B) is the shipped first-run default chat model:
// it is the smallest/entry tier, fits 8 GB-class phones comfortably, downloads
// fast, and is the model bundled into the AOSP image. Larger tiers (4B/9B/27B)
// remain available for manual selection on higher-memory hosts.
export const FIRST_RUN_DEFAULT_MODEL_ID: Eliza1TierId = "eliza-1-2b";

export const DEFAULT_ELIGIBLE_MODEL_IDS: ReadonlySet<string> = new Set(
  ELIZA_1_RELEASE_TIER_IDS,
);

export function isDefaultEligibleId(id: string): boolean {
  return DEFAULT_ELIGIBLE_MODEL_IDS.has(id);
}

/**
 * Per-tier publish-state hint. Keys are tier ids that are known to have
 * a pending Hugging Face bundle at the time the catalog snapshot was
 * cut. Tiers not listed here default to `"published"`. The recommender
 * consults this map (or a `publishStatus` field on a synthetic
 * `CatalogModel`) before recommending a first-run default — see
 * `recommendForFirstRun` and elizaOS/eliza#7629.
 *
 * Set the override env var `ELIZA_PUBLISH_STATUS_OVERRIDES` to a JSON
 * object like `{"eliza-1-2b":"published","eliza-1-9b":"pending"}` to
 * override at runtime without changing the static map (useful for QA
 * and for installs that depend on a private HF mirror).
 *
 * W3-12 audit (2026-05-14): the following areas require publish attention:
 *   - 2B vision: enabled in the catalog and canonical vision tier set;
 *     publish staging must include `vision/mmproj-2b.gguf` or manifest
 *     validation fails loudly.
 *   - Voice sub-models (wakeword, turn-detector, speaker-encoder, emotion):
 *     published under the unified elizaos/eliza-1 `voice/<model-id>/...`
 *     layout. Per-tier manifests still need to consume these paths directly
 *     where a bundle wants eager voice downloads.
 *   - Kokoro same voice preset: `af_same.bin` absent from all
 *     bundles; I7 eval showed regression. Current bundles ship af_bella
 *     and standard voices only.
 */
export const ELIZA_1_TIER_PUBLISH_STATUS: Readonly<
  Partial<Record<Eliza1TierId, "published" | "pending">>
> = {
  // 2026-06-28: the HuggingFace `elizaos/eliza-1` 9b / 27b / 27b-256k text
  // GGUFs still report `general.architecture = qwen35` (Qwen3.5 / "Qwen3.6
  // 27B") — the Gemma-4 cutover only landed for the 2b and 4b tiers. Mark the
  // un-cut tiers `pending` so first-run never recommends a non-Gemma model as
  // the default Eliza-1; flip back to published once the Gemma-4 fine-tunes are
  // staged + pass the text-architecture provenance gate (text-provenance.ts).
  "eliza-1-9b": "pending",
  "eliza-1-27b": "pending",
  "eliza-1-27b-256k": "pending",
};

export function eliza1TierPublishStatus(
  id: Eliza1TierId | string,
): "published" | "pending" {
  const override = readPublishStatusOverride(id);
  if (override) return override;
  const hint = (
    ELIZA_1_TIER_PUBLISH_STATUS as Record<
      string,
      "published" | "pending" | undefined
    >
  )[id];
  return hint ?? "published";
}

function readPublishStatusOverride(
  id: string,
): "published" | "pending" | undefined {
  const raw =
    typeof process !== "undefined"
      ? process.env.ELIZA_PUBLISH_STATUS_OVERRIDES
      : undefined;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[id];
    if (value === "published" || value === "pending") return value;
  } catch {
    // Malformed override JSON is non-fatal — fall back to the static
    // publish-status hint and the catalog's own `publishStatus` field.
  }
  return undefined;
}

export const ELIZA_1_PLACEHOLDER_IDS: ReadonlySet<string> = new Set(
  ELIZA_1_TIER_IDS,
);

export type VoiceBackendId = "kokoro";

/**
 * Per-tier voice backend policy. Kokoro is the sole on-device TTS backend
 * for every Eliza-1 tier. At ~82M params (a single ~60-80 MB GGUF) hitting
 * ~97ms CPU TTFB it is small and fast enough to ship on phones and large
 * hosts alike, so every tier bundles exactly Kokoro.
 */
export const ELIZA_1_VOICE_BACKENDS: Record<
  Eliza1TierId,
  ReadonlyArray<VoiceBackendId>
> = {
  "eliza-1-2b": ["kokoro"],
  "eliza-1-4b": ["kokoro"],
  "eliza-1-9b": ["kokoro"],
  "eliza-1-27b": ["kokoro"],
  "eliza-1-27b-256k": ["kokoro"],
};

const BASE_REQUIRED_KERNELS: LocalRuntimeKernel[] = ["turbo3", "turbo4"];

interface TierSpec {
  id: Eliza1TierId;
  params: CatalogModel["params"];
  parameterLabel?: CatalogModel["parameterLabel"];
  sizeGb: number;
  minRamGb: number;
  bucket: CatalogModel["bucket"];
  contextLength: number;
  textFile: string;
  q4MinRamGb: number;
  gpuProfile?: CatalogModel["gpuProfile"];
  hasEmbedding?: boolean;
  hasVision?: boolean;
  /**
   * WS3: whether this tier ships a default image-gen model in the bundle
   * extras (`ELIZA_1_BUNDLE_EXTRAS.json#imagegen.perTier`). All active
   * tiers default to SD 1.5 Q5_0 until a legacy-free split-diffusion text
   * encoder is available. The diffusion weights are runtime-downloaded —
   * they are NOT part of the base-v1 bundle.
   */
  hasImageGen?: boolean;
}

const TIER_SPECS: Readonly<Record<Eliza1TierId, TierSpec>> = {
  "eliza-1-2b": {
    id: "eliza-1-2b",
    params: "2B",
    sizeGb: 1.4,
    minRamGb: 4,
    q4MinRamGb: 4,
    bucket: "small",
    contextLength: 131072,
    textFile: "text/eliza-1-2b-128k.gguf",
    // WS2: vision enabled — the 2B tier is the standard "small-phone"
    // default for first-run users, so camera-to-reaction and screen
    // analysis must work here. The mmproj is ~361 MB Q8_0 (actual:
    // 361,518,784 bytes, published 2026-05-14); the arbiter owns the
    // swap with the text weights under pressure.
    hasVision: true,
    // WS3: image-gen on the standard small-phone default uses SD 1.5 Q5_0.
    hasImageGen: true,
  },
  "eliza-1-4b": {
    id: "eliza-1-4b",
    params: "4B",
    sizeGb: 2.6,
    // 4B is the shipped mid/mobile tier. The 2.6 GB Q4_K_M weights are sized
    // for a 128k Eliza-1 bundle on the Gemma 4 E4B base. Gemma KV is already
    // minimal (MQA + windowed-SWA + shared-KV) so the runtime ships stock KV
    // (f16/q8_0) — the legacy head_dim=128 QJL/Polar kernels do not apply to
    // Gemma's dual head dims (512 global / 256 swa). The floor stays above the
    // model size to leave headroom for the OS, app, and KV cache.
    minRamGb: 6,
    q4MinRamGb: 6,
    bucket: "mid",
    contextLength: 131072,
    textFile: "text/eliza-1-4b-128k.gguf",
    hasEmbedding: true,
    hasVision: true,
    // WS3: 4B uses the same monolithic SD 1.5 default as the rest of the
    // Gemma cutover catalog.
    hasImageGen: true,
  },
  "eliza-1-9b": {
    id: "eliza-1-9b",
    params: "9B",
    sizeGb: 5.4,
    minRamGb: 12,
    q4MinRamGb: 12,
    bucket: "large",
    contextLength: 131072,
    textFile: "text/eliza-1-9b-128k.gguf",
    gpuProfile: "rtx-3090",
    hasEmbedding: true,
    hasVision: true,
    // WS3: keep 9B on the monolithic SD 1.5 default until a legacy-free
    // split-diffusion text encoder is available.
    hasImageGen: true,
  },
  "eliza-1-27b": {
    id: "eliza-1-27b",
    params: "27B",
    sizeGb: 16.8,
    minRamGb: 32,
    q4MinRamGb: 32,
    bucket: "large",
    contextLength: 131072,
    textFile: "text/eliza-1-27b-128k.gguf",
    gpuProfile: "rtx-4090",
    hasEmbedding: true,
    hasVision: true,
    hasImageGen: true,
  },
  "eliza-1-27b-256k": {
    id: "eliza-1-27b-256k",
    params: "27B",
    parameterLabel: "27B 256k",
    sizeGb: 16.8,
    minRamGb: 48,
    q4MinRamGb: 48,
    bucket: "large",
    contextLength: 262144,
    textFile: "text/eliza-1-27b-256k.gguf",
    gpuProfile: "h200",
    hasEmbedding: true,
    hasVision: true,
    hasImageGen: true,
  },
};

function tierSlug(id: Eliza1TierId): string {
  return id.slice("eliza-1-".length);
}

function tierDisplaySlug(id: Eliza1TierId): string {
  switch (id) {
    case "eliza-1-2b":
      return "2B";
    case "eliza-1-4b":
      return "4B";
    case "eliza-1-9b":
      return "9B";
    case "eliza-1-27b":
      return "27B";
    case "eliza-1-27b-256k":
      return "27B-256k";
  }
  const exhaustive: never = id;
  return exhaustive;
}

function tierDisplayName(id: Eliza1TierId): string {
  return `eliza-1-${tierDisplaySlug(id)}`;
}

function bundleRemotePrefix(id: Eliza1TierId): string {
  return `bundles/${tierSlug(id)}`;
}

function bundlePath(_id: Eliza1TierId, rel: string): string {
  return rel;
}

function bundleRemotePath(id: Eliza1TierId, rel: string): string {
  return `${bundleRemotePrefix(id)}/${rel}`;
}

type SourceComponentMap = NonNullable<
  CatalogModel["sourceModel"]
>["components"];

function bundleComponent(
  id: Eliza1TierId,
  file: string,
): { repo: string; file: string } {
  return { repo: ELIZA_1_HF_REPO, file: bundleRemotePath(id, file) };
}

function primaryVoiceFileForTier(_id: Eliza1TierId): string {
  return "tts/kokoro/kokoro-82m-v1_0.gguf";
}

function asrFileForTier(id: Eliza1TierId): string {
  return `asr/mmproj-audio-${tierSlug(id)}-bf16.gguf`;
}

function sourceModelForTier(id: Eliza1TierId): CatalogModel["sourceModel"] {
  const spec = TIER_SPECS[id];
  const components: SourceComponentMap = {
    text: bundleComponent(id, spec.textFile),
    voice: bundleComponent(id, primaryVoiceFileForTier(id)),
    asr: bundleComponent(id, asrFileForTier(id)),
    vad: bundleComponent(id, "vad/silero-vad-v5.gguf"),
  };

  // Runtime ASR remains gated by the bundle manifest + provenance checks. The
  // catalog points at the Gemma audio mmproj artifact the active manifests use;
  // the fused runtime treats the bundle's `asr/` directory as the loadability
  // gate so additional ASR files can be added without changing this source
  // component handle.

  // LiteRT-LM single-file bundle for the on-device runtime: text + vision +
  // audio + MTP packed into one QAT (.litertlm) artifact, parallel to the
  // GGUF `text` component. Only the mobile-class tiers ship it.
  if (isOnDeviceTier(id)) {
    components.litert = bundleComponent(
      id,
      `text/eliza-1-${tierSlug(id)}.litertlm`,
    );
  }

  if (spec.hasEmbedding) {
    components.embedding = bundleComponent(
      id,
      "embedding/eliza-1-embedding.gguf",
    );
  }
  if (spec.hasVision) {
    components.vision = bundleComponent(
      id,
      `vision/mmproj-${tierSlug(id)}.gguf`,
    );
  }
  // Separate-drafter MTP is the Gemma release shape. Advertise the component
  // only for tiers whose gemma4-assistant drafter GGUF is actually hosted at
  // `bundles/<tier>/mtp/drafter-<tier>.gguf` (ELIZA_1_HOSTED_MTP_TIER_IDS);
  // the `dflash/` files still present on other tiers are legacy artifacts.
  if (hostedMtpDrafterAvailableForTier(id)) {
    components.mtp = bundleComponent(id, `mtp/drafter-${tierSlug(id)}.gguf`);
  }

  return { finetuned: false, components };
}

function runtimeForTier(
  id: Eliza1TierId,
  contextLength: number,
): CatalogModel["runtime"] {
  const requiresKernel: LocalRuntimeKernel[] =
    contextLength >= 65536
      ? [...BASE_REQUIRED_KERNELS, "turbo3_tcq"]
      : BASE_REQUIRED_KERNELS;
  const runtime: CatalogModel["runtime"] = {
    preferredBackend: "llama-cpp",
    optimizations: {
      // Gemma-aware RAM defaults (epic #9033). Eliza-1 is Gemma-4-based and
      // hits llama.cpp/#21690: the server KV context-checkpoint ring grows
      // unbounded on Gemma (a handful of ~16K-prompt turns filled ~64 GB in
      // the upstream repro). The on-device Eliza-1 runtime is single-user, so
      // pin single-slot decode (`-np 1`) and bound the checkpoint ring to 1 —
      // this is pure config, not a kernel change, and only touches the
      // Gemma-4 Eliza-1 tiers built here (never other models).
      parallel: 1,
      flashAttention: true,
      requiresKernel,
      // OpenVINO is the right backend for ASR/Whisper on Intel hosts but
      // never for autoregressive text. The text path uses optimized
      // llama.cpp kernels plus native MTP heads.
      unsupportedKernels: ["openvino"],
      ctxCheckpoints: 1,
      ctxCheckpointInterval: 4096,
    },
  };

  if (hostedMtpDrafterAvailableForTier(id)) {
    // Separate-drafter MTP: Gemma 4 ships an official standalone drafter
    // GGUF, loaded via `-md mtp/drafter-<tier>.gguf --spec-type draft-mtp`.
    //
    // Draft window = 1 (single speculative token). The bionic/desktop FFI
    // MTP engine uses a FIXED window equal to `draftMax` (no adaptive
    // acceptance schedule; `eliza-inference-ffi.cpp` sets
    // `sp.draft.n_max = draft_max`), so the catalog value is the live window.
    // The gemma4-assistant NextN head reliably predicts exactly one token;
    // its multi-token acceptance collapses past the first, so a larger window
    // burns draft forwards that get rejected and regresses decode. Measured on
    // Apple M-series Metal against the eliza-1-2b (Q8) target, greedy, across
    // 3 prompts:
    //   draftMax=1 => 1.37-1.66x win | =2 => ~0.90x | =4 => 0.61x | =6 => 0.37x
    // draftMax=1 is the measured-optimal, never-regress window for this drafter
    // on every tier; widening it is a per-tier/per-device tuning question that
    // needs on-hardware measurement before it can beat 1.
    runtime.mtp = {
      specType: "draft-mtp",
      drafterFile: `mtp/drafter-${tierSlug(id)}.gguf`,
      draftMin: 1,
      draftMax: 1,
      gpuLayers: "auto",
    };
  }

  return runtime;
}

const QUANT_SUFFIX: Record<CatalogQuantizationId, string> = {
  q3_k_m: "q3_k_m",
  // Google's official Gemma-4 QAT quant. `Q4_0` is the GGUF block format
  // their QAT checkpoints export to — distinct from the post-training
  // `q4_k_m` we ship as the desktop default.
  q4_0: "Q4_0",
  q4_k_m: "q4_k_m",
  q5_k_m: "q5_k_m",
  q6_k: "q6_k",
  q8_0: "q8_0",
  // LiteRT-LM mobile bundle suffix. The artifact is a `.litertlm`, not a
  // `.gguf`; `textLiteRtComponent` overrides the filename, so this suffix
  // only feeds the non-LiteRT variant-id naming path defensively.
  wna8o8: "wna8o8",
};

function textQuantizationMatrix(args: {
  primaryGgufFile: string;
  q4SizeGb: number;
  q4MinRamGb: number;
  /**
   * On-device (mobile-class) tier. When true the Gemma-4 QAT `Q4_0` variant
   * is flagged `mobilePreferred` so the on-device selector picks it over the
   * post-training `q4_k_m` default.
   */
  onDevice: boolean;
}): NonNullable<CatalogModel["quantization"]> {
  const fileBase = args.primaryGgufFile.replace(/\.gguf$/, "");
  const litertFile = `${fileBase.replace(/-128k$|-256k$/, "")}.litertlm`;
  const mk = (
    id: CatalogQuantizationId,
    label: CatalogQuantizationVariant["label"],
    scale: number,
    minRamScale: number,
    status: CatalogQuantizationVariant["status"],
    extra?: Pick<
      CatalogQuantizationVariant,
      "mobilePreferred" | "artifactFormat"
    >,
  ): CatalogQuantizationVariant => ({
    id,
    label,
    ggufFile:
      extra?.artifactFormat === "litertlm"
        ? litertFile
        : id === "q4_k_m"
          ? args.primaryGgufFile
          : `${fileBase}-${QUANT_SUFFIX[id]}.gguf`,
    sizeGb: Number((args.q4SizeGb * scale).toFixed(1)),
    minRamGb: Math.ceil(args.q4MinRamGb * minRamScale),
    status,
    ...extra,
  });

  const variants: CatalogQuantizationVariant[] = [
    mk("q3_k_m", "3-bit", 0.76, 0.85, "planned"),
    // Gemma-4 QAT Q4_0: same ~4-bit footprint as q4_k_m but the official
    // quantization-aware-trained checkpoint. Keep this planned until the
    // tier-specific `*-Q4_0.gguf` artifacts are present in the hosted bundle.
    mk(
      "q4_0",
      "4-bit",
      0.94,
      0.95,
      "planned",
      args.onDevice ? { mobilePreferred: true } : undefined,
    ),
    mk("q4_k_m", "4-bit", 1, 1, "published"),
    mk("q5_k_m", "5-bit", 1.22, 1.18, "planned"),
    mk("q6_k", "6-bit", 1.45, 1.35, "planned"),
    mk("q8_0", "8-bit", 1.95, 1.8, "planned"),
  ];

  // On-device tiers also advertise the LiteRT-LM `.litertlm` bundle: the
  // wNa8o8 (4-bit weight / 8-bit activation) mobile schema run by the
  // LiteRT-LM runtime (NPU/GPU delegate), not llama.cpp. It carries the same
  // ~4-bit footprint as the QAT Q4_0 GGUF.
  if (args.onDevice) {
    variants.push(
      mk("wna8o8", "4-bit", 0.94, 0.95, "planned", {
        artifactFormat: "litertlm",
      }),
    );
  }

  return { defaultVariantId: "q4_k_m", variants };
}

function blurbForTier(id: Eliza1TierId): string {
  const displayName = tierDisplayName(id);
  switch (id) {
    case "eliza-1-2b":
      return `${displayName} - smallest/entry local tier for low-memory phones and CPU fallback.`;
    case "eliza-1-4b":
      return `${displayName} - balanced local tier for modern laptops and desktops.`;
    case "eliza-1-9b":
      return `${displayName} - workstation local tier for stronger reasoning.`;
    case "eliza-1-27b":
      return `${displayName} - high-quality local tier for GPU workstations.`;
    case "eliza-1-27b-256k":
      return `${displayName} - long-context local tier for high-memory GPU workstations.`;
  }
  const exhaustive: never = id;
  return exhaustive;
}

function chatTier(id: Eliza1TierId): CatalogModel {
  const spec = TIER_SPECS[id];
  return {
    id,
    displayName: tierDisplayName(id),
    hfRepo: ELIZA_1_HF_REPO,
    hfPathPrefix: bundleRemotePrefix(id),
    ggufFile: bundlePath(id, spec.textFile),
    bundleManifestFile: bundlePath(id, "eliza-1.manifest.json"),
    params: spec.params,
    parameterLabel: spec.parameterLabel,
    quant: "Eliza-1 optimized local runtime",
    sizeGb: spec.sizeGb,
    minRamGb: spec.minRamGb,
    category: "chat",
    bucket: spec.bucket,
    contextLength: spec.contextLength,
    tokenizerFamily: "gemma4",
    runtimeClass: "fused-eliza1",
    sourceModel: sourceModelForTier(id),
    voiceBackends: ELIZA_1_VOICE_BACKENDS[id],
    runtime: runtimeForTier(id, spec.contextLength),
    gpuProfile: spec.gpuProfile,
    quantization: textQuantizationMatrix({
      primaryGgufFile: bundlePath(id, spec.textFile),
      q4SizeGb: spec.sizeGb,
      q4MinRamGb: spec.q4MinRamGb,
      onDevice: isOnDeviceTier(id),
    }),
    blurb: blurbForTier(id),
    publishStatus: eliza1TierPublishStatus(id),
  };
}

export const MODEL_CATALOG: CatalogModel[] = ELIZA_1_TIER_IDS.map((id) =>
  chatTier(id),
);

export function findCatalogModel(id: string): CatalogModel | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function buildHuggingFaceResolveUrlForPath(
  model: CatalogModel,
  filePath: string,
): string {
  const cleanFilePath = filePath.replace(/^\/+/, "");
  const cleanPrefix = model.hfPathPrefix?.replace(/^\/+|\/+$/g, "");
  const pathWithPrefix =
    cleanPrefix &&
    cleanFilePath !== cleanPrefix &&
    !cleanFilePath.startsWith(`${cleanPrefix}/`)
      ? `${cleanPrefix}/${cleanFilePath}`
      : cleanFilePath;
  if (model.hub === "modelscope") {
    const base =
      process.env.ELIZA_MODELSCOPE_BASE_URL?.trim().replace(/\/+$/, "") ||
      "https://www.modelscope.cn";
    const encodedPath = pathWithPrefix
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${base}/models/${model.hfRepo}/resolve/master/${encodedPath}`;
  }
  const { base } = resolveHfDownloadBase();
  const encodedPath = pathWithPrefix
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${model.hfRepo}/resolve/main/${encodedPath}?download=true`;
}

export function buildHuggingFaceResolveUrl(model: CatalogModel): string {
  return buildHuggingFaceResolveUrlForPath(model, model.ggufFile);
}
