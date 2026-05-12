// Eliza-1 manifest schema (`eliza-1.manifest.json`).
//
// Source of truth: packages/inference/AGENTS.md §6 (manifest), §3 (mandatory
// kernels), §2 (bundle/tier matrix). This module only defines the schema
// and tier/kernel constants — runtime validation lives in `validator.ts`.
//
// Coupling notes:
// - The kernel names here are *manifest-level* capabilities (what the bundle
//   advertises), not the lower-level llama.cpp kernel handles in `../types.ts`
//   (`turbo3` / `turbo4` / `turbo3_tcq` / `qjl_full` / `dflash`). The two
//   layers map but are not the same enum.
// - The schema URL `https://elizalabs.ai/schemas/eliza-1.manifest.v1.json` is
//   exported as a JSON Schema sibling file in this directory.
// - Shared-vocabulary invariant: every speculative-decoding GGUF in an
//   Eliza-1 bundle — the text/vision model and the DFlash drafter — is
//   Qwen3.5/Qwen3.6-lineage and shares the same Qwen3.5 BPE vocabulary
//   (248 320 tokens) and the same merges table. This is what makes
//   (a) DFlash speculative decoding correct (spec decoding only works if token
//   ids match), and (b) the drafter GGUFs ship without
//   their own `tokenizer.ggml.merges` (repaired at load time from the text GGUF
//   by `resolveDflashDrafter` in `../dflash-server.ts`). The shared *vocabulary*
//   is not the same thing as a shared *token-embedding tensor*: each component
//   carries its own `token_embd.weight` (different fine-tunes, often different
//   hidden sizes), so the vocab matrix is duplicated per GGUF and cannot be
//   deduplicated without a fused-architecture container — out of scope per
//   inference/AGENTS.md §2. See
//   `packages/inference/reports/porting/2026-05-11/qwen-backbone-unification.md`.

import type { LocalRuntimeKernel } from "@elizaos/shared";
import { z } from "zod";

export const ELIZA_1_MANIFEST_SCHEMA_VERSION = "1" as const;
export const ELIZA_1_MANIFEST_SCHEMA_URL =
  "https://elizalabs.ai/schemas/eliza-1.manifest.v1.json" as const;

// The shared Qwen3.5 BPE vocabulary every text/drafter component in an
// Eliza-1 bundle uses. Exported so runtime code can assert it (a GGUF whose
// `tokenizer.ggml.tokens` length differs from this is not an Eliza-1 component
// and the merges-repair / zero-re-tokenization assumptions do not hold).
export const ELIZA_1_TOKENIZER_FAMILY = "qwen35" as const;
export const ELIZA_1_TOKENIZER_VOCAB_SIZE = 248_320 as const;

// Tiers — see packages/inference/AGENTS.md §2 (Tier matrix). `27b-1m` is the
// GH200-class 1M-context variant of the 27B tier. `0_8b` and `2b` are the
// Qwen3.5 small/mid local tiers (the eliza-1 line is Qwen3.5-only per the
// 2026-05-12 operator directive — Qwen3 dense bases don't work with the
// dflash spec-decode path). `0_6b` / `1_7b` / `4b` remain here as
// **deprecated** tier ids: the elizaos/eliza-1-{0_6b,1_7b,4b} HF repos
// stay public for existing downloads, but their cards are marked
// DEPRECATED and no new SFT runs target them — see catalog.ts +
// packages/training/scripts/training/model_registry.py.
export const ELIZA_1_TIERS = [
  "0_8b",
  "0_6b",
  "1_7b",
  "2b",
  "4b",
  "9b",
  "27b",
  "27b-256k",
  "27b-1m",
] as const;
export type Eliza1Tier = (typeof ELIZA_1_TIERS)[number];

// Manifest-level kernel capability names. Per AGENTS.md §3:
// `turboquant_q3`, `turboquant_q4`, `qjl`, `polarquant`, `dflash` are
// the named optimizations the bundle declares. `turbo3_tcq` is required
// for any long-context text variant. The C-level llama.cpp kernel handles in
// `../types.ts` are an implementation detail of the runtime; the manifest
// speaks in terms of the optimization, not the .metal/.comp file.
//
// The relationship to the runtime-side `LocalRuntimeKernel` enum (the
// llama.cpp-handle layer, declared in `@elizaos/shared/local-inference/types`)
// is made explicit by `ELIZA1_TO_RUNTIME_KERNEL` / `RUNTIME_TO_ELIZA1_KERNEL`
// below — that is the single source of truth for the manifest↔runtime kernel
// bridge.
export const ELIZA_1_KERNELS = [
  "turboquant_q3",
  "turboquant_q4",
  "qjl",
  "polarquant",
  "dflash",
  "turbo3_tcq",
] as const;
export type Eliza1Kernel = (typeof ELIZA_1_KERNELS)[number];

// Manifest-kernel ↔ runtime-kernel bridge.
//
// `Eliza1Kernel` (this module, the bundle-manifest layer) names the *named
// optimization* a bundle advertises; `LocalRuntimeKernel`
// (`@elizaos/shared/local-inference/types`, the llama.cpp-handle layer) names
// the *fork kernel handle* the binary must expose. They overlap but are not the
// same enum:
//
//   turboquant_q3  ↔ turbo3       (Q3 KV-cache quant kernel)
//   turboquant_q4  ↔ turbo4       (Q4 KV-cache quant kernel)
//   qjl            ↔ qjl_full     (QuIP#-JL fused-attention kernel)
//   polarquant     ↔ polarquant   (same name on both layers)
//   dflash         ↔ dflash       (same name on both layers)
//   turbo3_tcq     ↔ turbo3_tcq   (same name on both layers)
//
// Every member of both enums is covered (both are total maps). When code needs
// to translate between the catalog's `requiresKernel: LocalRuntimeKernel[]` and
// the manifest's `kernels.required: Eliza1Kernel[]`, route it through these.
export const ELIZA1_TO_RUNTIME_KERNEL: Readonly<
  Record<Eliza1Kernel, LocalRuntimeKernel>
> = {
  turboquant_q3: "turbo3",
  turboquant_q4: "turbo4",
  qjl: "qjl_full",
  polarquant: "polarquant",
  dflash: "dflash",
  turbo3_tcq: "turbo3_tcq",
};

export const RUNTIME_TO_ELIZA1_KERNEL: Readonly<
  Record<LocalRuntimeKernel, Eliza1Kernel>
> = {
  turbo3: "turboquant_q3",
  turbo4: "turboquant_q4",
  qjl_full: "qjl",
  polarquant: "polarquant",
  dflash: "dflash",
  turbo3_tcq: "turbo3_tcq",
};

export const ELIZA_1_BACKENDS = [
  "metal",
  "vulkan",
  "cuda",
  "rocm",
  "cpu",
] as const;
export type Eliza1Backend = (typeof ELIZA_1_BACKENDS)[number];

// Required-kernel set per tier. Mirrors AGENTS.md §3:
// - All tiers require turboquant + qjl + polarquant + dflash.
// - 9B and larger tiers require `turbo3_tcq`. The validator also enforces the
//   same requirement dynamically for any bundle that declares a >64k text file,
//   so a future tier cannot publish long-context text without TCQ.
//
// The `q3` vs `q4` choice is tier-driven: 0_6b ships Q3; 1_7b and larger
// ship Q4.
export const REQUIRED_KERNELS_BY_TIER: Readonly<
  Record<Eliza1Tier, ReadonlyArray<Eliza1Kernel>>
> = {
  "0_8b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
  "0_6b": ["turboquant_q3", "qjl", "polarquant", "dflash"],
  "1_7b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
  "2b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
  "4b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
  "9b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
  "27b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
  "27b-256k": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
  "27b-1m": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
};

// Backends each tier is expected to support on shipped hardware. The small
// tiers (0.8B / 0.6B / 1.7B / 2B / 4B) do not need cuda/rocm.
export const SUPPORTED_BACKENDS_BY_TIER: Readonly<
  Record<Eliza1Tier, ReadonlyArray<Eliza1Backend>>
> = {
  "0_8b": ["metal", "vulkan", "cpu"],
  "0_6b": ["metal", "vulkan", "cpu"],
  "1_7b": ["metal", "vulkan", "cpu"],
  "2b": ["metal", "vulkan", "cpu"],
  "4b": ["metal", "vulkan", "cpu"],
  "9b": ["metal", "vulkan", "cuda", "rocm", "cpu"],
  "27b": ["metal", "vulkan", "cuda", "rocm", "cpu"],
  "27b-256k": ["metal", "vulkan", "cuda", "rocm", "cpu"],
  // 1M context only ships verified on CUDA today (GH200-class hosts).
  "27b-1m": ["cuda"],
};

// ---------------------------------------------------------------------------
// Zod definitions
// ---------------------------------------------------------------------------

const sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex chars");

const lineageEntry = z.object({
  base: z.string().min(1),
  license: z.string().min(1),
});

export const Eliza1LineageSchema = z.object({
  text: lineageEntry,
  voice: lineageEntry,
  drafter: lineageEntry,
  // Wave-6 (2026-05-10): manifest now records lineage for every shipped
  // component so license/dataset provenance is auditable per component.
  // All optional — a tier may omit ASR/embedding/vision/vad/wakeword by
  // leaving the corresponding `files.*` slot empty AND the lineage
  // entry undefined. The validator enforces lineage-vs-files consistency.
  asr: lineageEntry.optional(),
  embedding: lineageEntry.optional(),
  vision: lineageEntry.optional(),
  vad: lineageEntry.optional(),
  wakeword: lineageEntry.optional(),
});

export const Eliza1FileEntrySchema = z.object({
  path: z.string().min(1),
  sha256,
  // text files declare their context length so the runtime can pick the
  // largest variant that fits the device's RAM budget. Other file kinds
  // never have ctx.
  ctx: z.number().int().positive().optional(),
});

export const Eliza1FilesSchema = z.object({
  text: z.array(Eliza1FileEntrySchema).min(1),
  voice: z.array(Eliza1FileEntrySchema).min(1),
  asr: z.array(Eliza1FileEntrySchema),
  vision: z.array(Eliza1FileEntrySchema),
  dflash: z.array(Eliza1FileEntrySchema).min(1),
  cache: z.array(Eliza1FileEntrySchema).min(1),
  // Wave-6 (2026-05-10): the omni bundle ships a per-bundle dedicated
  // embedding model (Qwen3-Embedding-0.6B-GGUF on non-lite tiers) and
  // a Silero-VAD ONNX + an optional openWakeWord ONNX. All three are
  // optional in the schema — the 0_6b tier intentionally omits the
  // dedicated embedding (pools from text backbone) and a tier may
  // ship without wake-word support.
  //
  // Schema-level optionality: empty array = "this bundle does not
  // ship this component"; the validator enforces tier-specific
  // consistency rules (e.g. 1_7b-and-up MUST ship `embedding[]`).
  embedding: z.array(Eliza1FileEntrySchema).optional(),
  vad: z.array(Eliza1FileEntrySchema).optional(),
  wakeword: z.array(Eliza1FileEntrySchema).optional(),
});

export const Eliza1KernelEnumSchema = z.enum(ELIZA_1_KERNELS);
export const Eliza1BackendEnumSchema = z.enum(ELIZA_1_BACKENDS);
export const Eliza1TierEnumSchema = z.enum(ELIZA_1_TIERS);

export const Eliza1VerifiedBackendStatusSchema = z.object({
  status: z.enum(["pass", "fail", "skipped"]),
  atCommit: z.string().min(1),
  report: z.string().min(1),
  // Optional provenance for a "pass" recorded on a single device class — e.g.
  // the runtime Vulkan dispatch smoke that ran on one Intel-ANV GPU. `caveat`
  // names what device coverage is still missing so the recommendation engine
  // and release docs do not over-claim.
  device: z.string().min(1).optional(),
  caveat: z.string().min(1).optional(),
});

// Recipe-level kernel layout pins, folded in from the quantization recipes'
// `kernel_manifest` sidecar fragments
// (packages/training/scripts/quantization/_kernel_manifest.py). Keyed by the
// *recipe* kernel-target name (`turbo3` / `turbo4` / `turbo3_tcq` / `qjl1_256` /
// `polar_q4`) — NOT the manifest-level capability names in `ELIZA_1_KERNELS`.
// The runtime/downloader can verify the encoded blocks match the kernels it
// ships; the publish orchestrator already validates the sidecars exist.
export const Eliza1RecipeKernelPinsSchema = z.object({
  blockLayoutVersion: z.string().min(1),
  codebookHash: z.string().min(1),
  perBlockTolerance: z.number().positive(),
});

export const Eliza1KernelsSchema = z.object({
  required: z.array(Eliza1KernelEnumSchema).min(1),
  optional: z.array(Eliza1KernelEnumSchema),
  verifiedBackends: z.object({
    metal: Eliza1VerifiedBackendStatusSchema,
    vulkan: Eliza1VerifiedBackendStatusSchema,
    cuda: Eliza1VerifiedBackendStatusSchema,
    rocm: Eliza1VerifiedBackendStatusSchema,
    cpu: Eliza1VerifiedBackendStatusSchema,
  }),
  recipeManifest: z.record(z.string(), Eliza1RecipeKernelPinsSchema).optional(),
});

// Wave-6: voice surface declares which expressive features the bundled
// TTS supports. Today these are tag-driven inline in the input text;
// presence of `singing` or `emotion-tags` here lets the runtime expose
// the relevant API surface and lets the planner emit tags inline.
export const ELIZA_1_VOICE_CAPABILITIES = [
  "tts",
  "emotion-tags",
  "singing",
] as const;
export const ELIZA_1_VOICE_MANIFEST_VERSION = "1";
export const VOICE_PRESET_CACHE_PATH = "cache/voice-preset-default.bin";
export type Eliza1VoiceCapability = (typeof ELIZA_1_VOICE_CAPABILITIES)[number];

export const Eliza1VoiceSchema = z.object({
  version: z.string().min(1),
  frozen: z.literal(true),
  cache: z.object({
    speakerPreset: z.string().min(1),
    phraseCacheSeed: z.string().min(1),
  }),
  capabilities: z.array(z.enum(ELIZA_1_VOICE_CAPABILITIES)).default(["tts"]),
});

export const Eliza1EvalsSchema = z.object({
  textEval: z.object({
    score: z.number().min(0).max(1),
    passed: z.boolean(),
  }),
  voiceRtf: z.object({
    rtf: z.number().nonnegative(),
    passed: z.boolean(),
  }),
  e2eLoopOk: z.boolean(),
  thirtyTurnOk: z.boolean(),
  // Wave-6 additions — all optional so a tier can publish without
  // an ASR / embedding component declared. `expressive` covers the
  // singing/emotion-tag eval gates from `eliza1_gates.yaml`. The
  // validator refuses defaultEligible=true if any declared component's
  // gate is missing OR fails.
  asrWer: z
    .object({
      wer: z.number().nonnegative(),
      passed: z.boolean(),
    })
    .optional(),
  embedMteb: z
    .object({
      score: z.number().min(0).max(1),
      passed: z.boolean(),
    })
    .optional(),
  vadLatencyMs: z
    .object({
      median: z.number().nonnegative(),
      boundaryMs: z.number().nonnegative().optional(),
      endpointMs: z.number().nonnegative().optional(),
      falseBargeInRate: z.number().min(0).max(1).optional(),
      passed: z.boolean(),
    })
    .optional(),
  expressive: z
    .object({
      tagFaithfulness: z.number().min(0).max(1),
      mosExpressive: z.number().nonnegative(),
      tagLeakage: z.number().nonnegative(),
      passed: z.boolean(),
    })
    .optional(),
  // DFlash speculative-decoding bench. Optional — a bundle whose DFlash
  // drafter is still a stand-in records this as `passed: false` with
  // `acceptanceRate: null` / `speedup: null` ("needs hardware / needs a
  // trained drafter" — recorded, not faked, per AGENTS.md §3 / §7). The
  // gate thresholds live in the `dflash:` section of `eliza1_gates.yaml`;
  // the bench numbers come from `dflash_drafter_runtime_smoke.mjs --bench`.
  dflash: z
    .object({
      /** accepted/drafted; null when no hardware/drafter was available. */
      acceptanceRate: z.number().min(0).max(1).nullable(),
      /** drafter-on tok/s ÷ baseline tok/s; null when not measured. */
      speedup: z.number().nonnegative().nullable(),
      passed: z.boolean(),
    })
    .optional(),
});

export const Eliza1RamBudgetSchema = z
  .object({
    min: z.number().int().positive(),
    recommended: z.number().int().positive(),
  })
  .refine((r) => r.recommended >= r.min, {
    message: "ramBudgetMb.recommended must be >= ramBudgetMb.min",
  });

// Release-state vocabulary. `base-v1` is the v1 product: the upstream BASE
// models — GGUF-converted via the elizaOS/llama.cpp fork and fully
// Eliza-optimized (every quant/kernel trick in inference/AGENTS.md §3) —
// but NOT fine-tuned (fine-tuning ships in v2). `finetuned-v2` is the v2
// state; `local-standin` is a non-publishable staging shape;
// `upload-candidate` / `final` are the historical fine-tuned-v1 publish
// states retained for forward-compat. Mirrors `ELIZA_1_RELEASE_STATES` in
// `packages/training/scripts/manifest/eliza1_manifest.py`.
export const ELIZA_1_RELEASE_STATES = [
  "local-standin",
  "base-v1",
  "finetuned-v2",
  "upload-candidate",
  "final",
] as const;
export type Eliza1ReleaseState = (typeof ELIZA_1_RELEASE_STATES)[number];

// Provenance slots — the bundle components whose upstream source repo a
// `base-v1` manifest must record. Mirrors `ELIZA_1_PROVENANCE_SLOTS`
// (Python side).
export const ELIZA_1_PROVENANCE_SLOTS = [
  "text",
  "voice",
  "asr",
  "vad",
  "embedding",
  "vision",
  "drafter",
] as const;
export type Eliza1ProvenanceSlot = (typeof ELIZA_1_PROVENANCE_SLOTS)[number];

const eliza1SourceModelEntry = z.object({
  /** Upstream HuggingFace repo this component is converted from. */
  repo: z.string().min(1),
  /** Specific file in the upstream repo, when the source is one file. */
  file: z.string().min(1).optional(),
  /** The converter / recipe path used (e.g. `<fork>/convert_hf_to_gguf.py`). */
  convertedVia: z.string().min(1).optional(),
  /** Free-text provenance note. */
  note: z.string().min(1).optional(),
});

// `provenance` — optional manifest block. Required on a `base-v1` bundle so
// the "base, not fine-tuned" plan is auditable: which upstream repo each
// shipped component is converted from, and whether v1 fine-tuning was
// applied (always `false` for the base-v1 release). The contract validator
// enforces per-component coverage for `base-v1`.
export const Eliza1ProvenanceSchema = z.object({
  releaseState: z.enum(ELIZA_1_RELEASE_STATES),
  finetuned: z.boolean(),
  sourceModels: z.record(
    z.enum(ELIZA_1_PROVENANCE_SLOTS),
    eliza1SourceModelEntry,
  ),
});

export const Eliza1ManifestSchema = z
  .object({
    $schema: z.literal(ELIZA_1_MANIFEST_SCHEMA_URL).optional(),
    id: z.string().min(1),
    tier: Eliza1TierEnumSchema,
    version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/,
        "version must be semver (e.g. 1.0.0)",
      ),
    publishedAt: z.string().datetime(),
    lineage: Eliza1LineageSchema,
    files: Eliza1FilesSchema,
    kernels: Eliza1KernelsSchema,
    evals: Eliza1EvalsSchema,
    ramBudgetMb: Eliza1RamBudgetSchema,
    // Wave-6: optional. Default = `{ capabilities: ["tts"] }` (base TTS only,
    // no emotion tags, no singing). Bundles that ship the omnivoice-singing
    // weights advertise `["tts","emotion-tags","singing"]`.
    voice: Eliza1VoiceSchema.optional(),
    // Optional. Present on `base-v1` bundles (the upstream base models,
    // GGUF-converted + fully optimized, NOT fine-tuned). Records the
    // release state, the not-fine-tuned flag, and the upstream source repo
    // per shipped component. The contract validator requires per-component
    // coverage when `releaseState === "base-v1"`.
    provenance: Eliza1ProvenanceSchema.optional(),
    defaultEligible: z.boolean(),
  })
  // The id MUST encode the tier so catalogs can derive tier from id without
  // re-reading the manifest. Example: `id: "eliza-1-9b"`.
  .refine(
    (m) =>
      m.id === `eliza-1-${m.tier}` || m.id.startsWith(`eliza-1-${m.tier}-`),
    {
      message: "id must start with `eliza-1-<tier>`",
      path: ["id"],
    },
  );
