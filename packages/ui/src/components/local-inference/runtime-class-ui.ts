/**
 * Runtime-class labeling + platform-servability helpers for the local-model
 * picker UIs.
 *
 * The discriminator is computed on the server (`runtimeClass` on
 * `CatalogModel` / `InstalledModel`); the UI reads the field and renders an
 * honest label so the user knows which models run the full Eliza-1 pipeline vs
 * the reduced-optimization generic GGUF path, and which picks can't run on the
 * current platform at all.
 */

import {
  classifyCatalogModelRuntimeClass,
  classifyInstalledModelRuntimeClass,
  type RuntimeClass,
} from "@elizaos/shared/local-inference";
import type {
  CatalogModel,
  InstalledModel,
} from "../../api/client-local-inference";
import { getFrontendPlatform } from "../../platform/platform-guards";

export type { RuntimeClass };

/** Resolve the runtime class for an installed model (reads the field; backfills). */
export function installedRuntimeClass(model: InstalledModel): RuntimeClass {
  return classifyInstalledModelRuntimeClass(model);
}

/** Resolve the runtime class for a catalog/search model (reads the field). */
export function catalogRuntimeClass(model: CatalogModel): RuntimeClass {
  return model.runtimeClass ?? classifyCatalogModelRuntimeClass(model);
}

/**
 * Short badge label for a runtime class. Fused Eliza-1 runs the full local
 * pipeline (MTP, fork KV kernels, fused voice/vision); generic is a single
 * GGUF with stock optimizations.
 */
export function runtimeClassBadge(runtimeClass: RuntimeClass): string {
  return runtimeClass === "fused-eliza1" ? "eliza-1" : "generic";
}

/** Longer descriptor used in tooltips / option suffixes. */
export function runtimeClassDescription(runtimeClass: RuntimeClass): string {
  return runtimeClass === "fused-eliza1"
    ? "eliza-1 — full pipeline"
    : "generic — reduced optimizations";
}

/**
 * Whether the current platform can serve a model of this runtime class.
 *
 * Fused Eliza-1 bundles are servable wherever the fused runtime is present.
 * Generic single-file GGUF needs the explicit-`modelPath` binding, which
 * ships on mobile (Capacitor) but is not built into the desktop/web runtime
 * yet — so a generic pick is flagged unavailable off-mobile. Mirrors the
 * server-side `canServeRuntimeClassOnHost` gate so the UI disables exactly the
 * picks the route would reject.
 */
export function canServeRuntimeClassOnPlatform(
  runtimeClass: RuntimeClass,
): boolean {
  if (runtimeClass === "fused-eliza1") return true;
  const platform = getFrontendPlatform();
  return platform === "ios" || platform === "android";
}

/**
 * Human-readable reason a runtime class can't run on the current platform, or
 * `null` when it is servable. Drives the disabled annotation in the model
 * pickers so a generic GGUF pick on desktop/web is visibly flagged instead of
 * silently failing at activation.
 */
export function runtimeClassUnavailableReason(
  runtimeClass: RuntimeClass,
): string | null {
  if (canServeRuntimeClassOnPlatform(runtimeClass)) return null;
  return "Not runnable on this platform — generic GGUF needs a mobile build";
}
