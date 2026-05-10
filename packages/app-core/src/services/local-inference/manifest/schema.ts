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
export const ELIZA_1_TIERS = [
  "lite-0_6b",
  "mobile-1_7b",
  "desktop-9b",
  "pro-27b",
  "server-h200",
] as const;
export type Eliza1Tier = (typeof ELIZA_1_TIERS)[number];

// Manifest-level kernel capability names. Per AGENTS.md §3:
// `turboquant_q3`, `turboquant_q4`, `qjl`, `polarquant`, `dflash` are
// the named optimizations the bundle declares. `turbo3_tcq` is optional
// (long-context only). The C-level llama.cpp kernel handles in
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

export const ELIZA_1_BACKENDS = ["metal", "vulkan", "cuda", "cpu"] as const;
export type Eliza1Backend = (typeof ELIZA_1_BACKENDS)[number];

// Required-kernel set per tier. Mirrors AGENTS.md §3:
// - All tiers require turboquant + qjl + polarquant + dflash.
// - desktop / pro / server additionally have `turbo3_tcq` listed as required
//   for the longest-context variant; we keep `turbo3_tcq` in the *optional*
//   set so a bundle without the long-context variant can still publish, and
//   require it dynamically when the bundle declares a >64k text file (the
//   validator enforces that — see `validator.ts`).
//
// The `q3` vs `q4` choice is tier-driven: `lite` ships Q3, `mobile` ships
// Q3 or Q4, the rest ship Q4. The validator accepts either turboquant
// variant on `mobile`; other tiers must match exactly.
export const REQUIRED_KERNELS_BY_TIER: Readonly<
  Record<Eliza1Tier, ReadonlyArray<Eliza1Kernel>>
> = {
  "lite-0_6b": ["turboquant_q3", "qjl", "polarquant", "dflash"],
  "mobile-1_7b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
  "desktop-9b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
  "pro-27b": ["turboquant_q4", "qjl", "polarquant", "dflash"],
  "server-h200": ["turboquant_q4", "qjl", "polarquant", "dflash"],
};

// Backends each tier is expected to support on shipped hardware. A tier
// that ships only on Apple silicon (mobile, lite) does not need cuda.
export const SUPPORTED_BACKENDS_BY_TIER: Readonly<
  Record<Eliza1Tier, ReadonlyArray<Eliza1Backend>>
> = {
  "lite-0_6b": ["metal", "vulkan", "cpu"],
  "mobile-1_7b": ["metal", "vulkan", "cpu"],
  "desktop-9b": ["metal", "vulkan", "cuda", "cpu"],
  "pro-27b": ["metal", "vulkan", "cuda", "cpu"],
  "server-h200": ["cuda", "vulkan", "cpu"],
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
    cpu: Eliza1VerifiedBackendStatusSchema,
  }),
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
    defaultEligible: z.boolean(),
  })
  // The id MUST encode the tier so catalogs can derive tier from id without
  // re-reading the manifest. AGENTS.md §6 sample: `id: "eliza-1-desktop-9b"`.
  .refine((m) => m.id === `eliza-1-${m.tier}` || m.id.startsWith(`eliza-1-${m.tier}-`), {
    message: "id must start with `eliza-1-<tier>`",
    path: ["id"],
  });
