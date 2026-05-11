// TypeScript types derived from the Zod schema in `./schema.ts`.
// Importing this module gives consumers a strongly-typed view of an Eliza-1
// manifest without depending on Zod at runtime — useful for catalog code,
// recommendation, and downloader interfaces that only read manifests.

import type { z } from "zod";
import type {
  Eliza1BackendEnumSchema,
  Eliza1EvalsSchema,
  Eliza1FileEntrySchema,
  Eliza1FilesSchema,
  Eliza1KernelEnumSchema,
  Eliza1KernelsSchema,
  Eliza1LineageSchema,
  Eliza1ManifestSchema,
  Eliza1RamBudgetSchema,
  Eliza1TierEnumSchema,
  Eliza1VerifiedBackendStatusSchema,
  Eliza1VoiceSchema,
} from "./schema";

export type Eliza1Tier = z.infer<typeof Eliza1TierEnumSchema>;
export type Eliza1Kernel = z.infer<typeof Eliza1KernelEnumSchema>;
export type Eliza1Backend = z.infer<typeof Eliza1BackendEnumSchema>;
export type Eliza1FileEntry = z.infer<typeof Eliza1FileEntrySchema>;
export type Eliza1Files = z.infer<typeof Eliza1FilesSchema>;
export type Eliza1Lineage = z.infer<typeof Eliza1LineageSchema>;
export type Eliza1Kernels = z.infer<typeof Eliza1KernelsSchema>;
export type Eliza1Evals = z.infer<typeof Eliza1EvalsSchema>;
export type Eliza1RamBudget = z.infer<typeof Eliza1RamBudgetSchema>;
export type Eliza1Voice = z.infer<typeof Eliza1VoiceSchema>;
export type Eliza1VerifiedBackendStatus = z.infer<
  typeof Eliza1VerifiedBackendStatusSchema
>;
export type Eliza1Manifest = z.infer<typeof Eliza1ManifestSchema>;

/**
 * Capability snapshot of a target device — whatever the runtime detected
 * (Metal on Mac, Vulkan on Linux/Android, CUDA on NVIDIA, CPU as floor).
 * `canSetAsDefault()` checks the manifest's verifiedBackends against this.
 */
export interface Eliza1DeviceCaps {
  availableBackends: ReadonlyArray<Eliza1Backend>;
  ramMb: number;
}
