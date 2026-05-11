/**
 * Resolve a model's RAM budget for the recommendation engine.
 *
 * For installed Eliza-1 tiers WITH a published `eliza-1.manifest.json`
 * on disk we prefer the manifest's `ramBudgetMb.{min, recommended}`
 * block — that's what packages/inference/AGENTS.md §3 + §6 designate
 * as the source of truth for per-bundle memory expectations. For every
 * other model (non-Eliza-1, uninstalled tiers, or Eliza-1 bundles that
 * predate the manifest publish) we fall back to the catalog scalar
 * `model.minRamGb` and synthesize a `recommendedMb` that mirrors the
 * historical `assessFit` semantics.
 *
 * The manifest read is best-effort: a missing or malformed manifest
 * never throws — recommendation runs at runtime and a broken manifest
 * must not crash the dashboard. Build-time gates live in the publish
 * script (packages/training/scripts/manifest/eliza1_manifest.py) and
 * the validator (`./manifest/validator.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { ELIZA_1_TIER_IDS, type Eliza1TierId } from "./catalog";
import { type Eliza1Manifest, validateManifest } from "./manifest";
import type { CatalogModel, InstalledModel } from "./types";

const MB_PER_GB = 1024;

export interface RamBudget {
  /** Minimum RAM the bundle will boot under, in megabytes. */
  minMb: number;
  /** RAM the bundle expects for nominal workloads, in megabytes. */
  recommendedMb: number;
  /** Where the numbers came from. `manifest` only when both came from
   *  a validated `eliza-1.manifest.json` next to the installed bundle. */
  source: "manifest" | "catalog";
}

/**
 * Loader contract — keeps the helper testable without touching disk.
 * Production callers pass `defaultManifestLoader`; tests inject a stub.
 */
export type ManifestLoader = (
  modelId: string,
  installed: InstalledModel | undefined,
) => Eliza1Manifest | null;

const ELIZA_1_TIER_ID_SET: ReadonlySet<string> = new Set(ELIZA_1_TIER_IDS);

function isEliza1TierId(id: string): id is Eliza1TierId {
  return ELIZA_1_TIER_ID_SET.has(id);
}

function manifestTierFromId(id: Eliza1TierId): string {
  // Catalog id `eliza-1-<tier>` → manifest tier `<tier>`.
  return id.slice("eliza-1-".length);
}

/**
 * Production manifest loader — reads `eliza-1.manifest.json` from the
 * installed bundle's directory. Two candidate paths are probed:
 *
 *   1. `dirname(dirname(model.path))` — the canonical bundle root when
 *      the GGUF lives in a `text/` subdir per AGENTS.md §2.
 *   2. `dirname(model.path)` — flat layout used by some test fixtures
 *      and pre-bundle installs.
 *
 * Returns `null` for any failure: missing file, JSON parse error,
 * manifest validation error, or tier mismatch.
 */
export function defaultManifestLoader(
  modelId: string,
  installed: InstalledModel | undefined,
): Eliza1Manifest | null {
  if (!installed?.path) return null;
  if (!isEliza1TierId(modelId)) return null;

  const expectedTier = manifestTierFromId(modelId);
  const candidates = [
    path.join(
      path.dirname(path.dirname(installed.path)),
      "eliza-1.manifest.json",
    ),
    path.join(path.dirname(installed.path), "eliza-1.manifest.json"),
  ];

  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = validateManifest(parsed);
    if (!result.ok) continue;
    if (result.manifest.tier !== expectedTier) continue;
    return result.manifest;
  }
  return null;
}

/**
 * Resolve a `RamBudget` for `model`, optionally consulting the on-disk
 * manifest of an installed Eliza-1 bundle.
 *
 * `installed` and `manifestLoader` are both optional — passing neither
 * always returns the catalog-scalar fallback. The recommendation engine
 * passes both at call sites where it has the installed-models list.
 */
export function resolveRamBudget(
  model: CatalogModel,
  installed?: InstalledModel,
  manifestLoader: ManifestLoader = defaultManifestLoader,
): RamBudget {
  if (isEliza1TierId(model.id) && installed) {
    const manifest = manifestLoader(model.id, installed);
    if (manifest) {
      return {
        minMb: manifest.ramBudgetMb.min,
        recommendedMb: manifest.ramBudgetMb.recommended,
        source: "manifest",
      };
    }
  }
  // Catalog fallback: `minRamGb` is the historical "won't fit" line.
  // The recommended budget mirrors what the older recommender already
  // baked into `assessFit` — there is no published "recommended" scalar
  // in the catalog row, so the same number is reused for both.
  const minMb = Math.round(model.minRamGb * MB_PER_GB);
  return {
    minMb,
    recommendedMb: minMb,
    source: "catalog",
  };
}
