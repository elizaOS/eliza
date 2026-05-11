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

import { z } from "zod";

export const ELIZA_1_MANIFEST_SCHEMA_VERSION = "1" as const;
export const ELIZA_1_MANIFEST_SCHEMA_URL =
  "https://elizalabs.ai/schemas/eliza-1.manifest.v1.json" as const;

// Tiers — see packages/inference/AGENTS.md §2 (Tier matrix).
export const ELIZA_1_TIERS = ["0_6b", "1_7b", "9b", "27b", "27b-256k"] as const;
export type Eliza1Tier = (typeof ELIZA_1_TIERS)[number];

// Manifest-level kernel capability names. Per AGENTS.md §3:
// `turboquant_q3`, `turboquant_q4`, `qjl`, `polarquant`, `dflash` are
// the named optimizations the bundle declares. `turbo3_tcq` is required
// for any long-context text variant. The C-level llama.cpp kernel handles in
// `../types.ts` are an implementation detail of the runtime; the manifest
// speaks in terms of the optimization, not the .metal/.comp file.
export const ELIZA_1_KERNELS = [
  "turboquant_q3",
  "turboquant_q4",
  "qjl",
  "polarquant",
  "dflash",
  "turbo3_tcq",
] as const;
export type Eliza1Kernel = (typeof ELIZA_1_KERNELS)[number];

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
// The `q3` vs `q4` choice is tier-driven: 0.6B ships Q3; 1.7B and larger
// ship Q4.
export const REQUIRED_KERNELS_BY_TIER: Readonly<
  Record<Eliza1Tier, ReadonlyArray<Eliza1Kernel>>
> = {
  "0_6b": ["turboquant_q3", "qjl", "polarquant", "dflash"],
  "1_7b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
  "9b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
  "27b": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
  "27b-256k": ["turboquant_q4", "qjl", "polarquant", "dflash", "turbo3_tcq"],
};

// Backends each tier is expected to support on shipped hardware. The 0.6B and
// 1.7B tiers do not need cuda/rocm.
export const SUPPORTED_BACKENDS_BY_TIER: Readonly<
  Record<Eliza1Tier, ReadonlyArray<Eliza1Backend>>
> = {
  "0_6b": ["metal", "vulkan", "cpu"],
  "1_7b": ["metal", "vulkan", "cpu"],
  "9b": ["metal", "vulkan", "cuda", "rocm", "cpu"],
  "27b": ["metal", "vulkan", "cuda", "rocm", "cpu"],
  "27b-256k": ["metal", "vulkan", "cuda", "rocm", "cpu"],
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
  // embedding model (Qwen3-Embedding-0.6B-GGUF on non-0.6B tiers) and
  // a Silero-VAD ONNX + an optional openWakeWord ONNX. All three are
  // optional in the schema — the 0.6B tier intentionally omits the
  // dedicated embedding (pools from text backbone) and a tier may
  // ship without wake-word support.
  //
  // Schema-level optionality: empty array = "this bundle does not
  // ship this component"; the validator enforces tier-specific
  // consistency rules (e.g. 1.7B-and-up MUST ship `embedding[]`).
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
});

export const Eliza1RamBudgetSchema = z
  .object({
    min: z.number().int().positive(),
    recommended: z.number().int().positive(),
  })
  .refine((r) => r.recommended >= r.min, {
    message: "ramBudgetMb.recommended must be >= ramBudgetMb.min",
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
