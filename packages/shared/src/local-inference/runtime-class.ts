/**
 * Local-inference runtime-class discriminator.
 *
 * There are exactly two desktop text runtimes, and they are NOT
 * interchangeable:
 *
 *   - `"fused-eliza1"` — an Eliza-1 bundle served by the fused
 *     `libelizainference` (`desktop-fused-ffi-backend-runtime.ts`). The fused
 *     context is anchored at a *bundle root* (`ffi.create(bundleRoot)` →
 *     `<bundleRoot>/text/*.gguf`) and the full optimization stack rides along:
 *     embedded draft head speculative decoding, stock q8_0 KV cache,
 *     native tokenization over the resident Gemma 4 (eliza-1) vocab, and fused
 *     voice/vision. It cannot load an arbitrary single GGUF — the vocab and the
 *     KV cache layout are tokenizer/format-specific to Eliza-1.
 *
 *   - `"generic-gguf"` — a single user-picked GGUF (a Hugging Face / ModelScope
 *     download, or an external-tool scan) served from an explicit `modelPath`
 *     with stock f16 KV and no fused MTP/voice/vision. This is the honest
 *     "reduced optimizations" path for "any model you downloaded".
 *
 * The discriminator is computed ONCE here from authoritative structural signals
 * (catalog membership / bundle layout), never re-derived downstream by
 * id-prefix string matching. The dispatcher, the load-arg resolver, and the UI
 * all read the `runtimeClass` field.
 */

import { ELIZA_1_PLACEHOLDER_IDS } from "./catalog.js";
import type { CatalogModel, InstalledModel } from "./types.js";

/** Which desktop text runtime a model is served by. */
export type RuntimeClass = "fused-eliza1" | "generic-gguf";

/**
 * Classify a catalog entry. An entry is `fused-eliza1` when it is one of the
 * curated Eliza-1 tiers (or their hidden drafter companions) — equivalently,
 * when it ships an Eliza-1 bundle manifest. Everything else (synthetic
 * Hugging Face / ModelScope search results, ad-hoc GGUF repos) is
 * `generic-gguf`.
 */
export function classifyCatalogModelRuntimeClass(
  model: Pick<CatalogModel, "id" | "bundleManifestFile" | "runtimeRole">,
): RuntimeClass {
  if (ELIZA_1_PLACEHOLDER_IDS.has(model.id)) return "fused-eliza1";
  if (model.bundleManifestFile) return "fused-eliza1";
  // Hidden MTP-drafter companions are keyed to an Eliza-1 tier by id suffix
  // and are part of the fused bundle, not a standalone generic GGUF.
  if (
    model.runtimeRole === "mtp-drafter" &&
    ELIZA_1_PLACEHOLDER_IDS.has(model.id.replace(/-drafter$/, ""))
  ) {
    return "fused-eliza1";
  }
  return "generic-gguf";
}

/**
 * Classify an installed-model registry entry. An entry is `fused-eliza1` when
 * it was materialized as an Eliza-1 bundle (it carries a `bundleRoot` AND its
 * id is one of the curated tiers). A single downloaded/scanned GGUF that lives
 * directly under the models dir (no bundle layout) is `generic-gguf`.
 *
 * An entry that already carries an explicit `runtimeClass` (written at install
 * time) is trusted verbatim.
 */
export function classifyInstalledModelRuntimeClass(
  model: Pick<InstalledModel, "id" | "bundleRoot" | "runtimeClass">,
): RuntimeClass {
  if (model.runtimeClass) return model.runtimeClass;
  if (model.bundleRoot && ELIZA_1_PLACEHOLDER_IDS.has(model.id)) {
    return "fused-eliza1";
  }
  return "generic-gguf";
}

/**
 * Backfill `runtimeClass` on an installed-model entry that predates the field
 * (legacy registry rows + freshly scanned external models). Returns the same
 * reference when the field is already present so callers can cheaply skip a
 * rewrite.
 */
export function withRuntimeClass(model: InstalledModel): InstalledModel {
  if (model.runtimeClass) return model;
  return {
    ...model,
    runtimeClass: classifyInstalledModelRuntimeClass(model),
  };
}
