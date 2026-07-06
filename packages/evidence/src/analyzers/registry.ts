/**
 * The analyzer registry: a flat, static array of every built-in analyzer plus a
 * name lookup. Deliberately data, not a plugin system — no dynamic loading, no
 * discovery — so the set of analyzers is auditable at a glance and the runner
 * fans a known list over the bundle. Callers select a subset with
 * `analyzersForTier` / `analyzersForKind`, or pass an explicit list to the
 * runner.
 */

import type { ArtifactKind, Tier } from "../schema.ts";
import { ariaTreeAnalyzer } from "./aria.ts";
import { brandRulesAnalyzer } from "./brand.ts";
import { colorCornersAnalyzer, colorPaletteAnalyzer } from "./color.ts";
import { diffChangeAnalyzer, diffRegionAnalyzer } from "./diff.ts";
import { videoKeyframesAnalyzer } from "./keyframes.ts";
import { ocrTesseractAnalyzer, ocrUnlimitedAnalyzer } from "./ocr/ocr.ts";
import { perceptualHashAnalyzer } from "./phash.ts";
import type { Analyzer } from "./types.ts";

/** Every built-in analyzer. Order is the deterministic run order. */
export const ANALYZERS: readonly Analyzer[] = [
  ocrTesseractAnalyzer,
  ocrUnlimitedAnalyzer,
  colorPaletteAnalyzer,
  colorCornersAnalyzer,
  brandRulesAnalyzer,
  diffChangeAnalyzer,
  diffRegionAnalyzer,
  perceptualHashAnalyzer,
  ariaTreeAnalyzer,
  videoKeyframesAnalyzer,
];

const BY_NAME = new Map(ANALYZERS.map((analyzer) => [analyzer.name, analyzer]));

/** Look up a registered analyzer by its dotted name, or undefined. */
export function getAnalyzer(name: string): Analyzer | undefined {
  return BY_NAME.get(name);
}

/** Analyzers whose tier is runnable at `tier` (cpu is runnable everywhere). */
export function analyzersForTier(
  tier: Tier,
  analyzers: readonly Analyzer[] = ANALYZERS,
): Analyzer[] {
  return analyzers.filter((analyzer) => tierRunnable(analyzer.tier, tier));
}

/** Analyzers that consume `kind`. */
export function analyzersForKind(
  kind: ArtifactKind,
  analyzers: readonly Analyzer[] = ANALYZERS,
): Analyzer[] {
  return analyzers.filter((analyzer) => analyzer.kinds.includes(kind));
}

/**
 * Whether an analyzer of `analyzerTier` may run at `runTier`. `cpu` runs at any
 * tier; `gpu` runs only at gpu/full; `full` runs only at full. An analyzer above
 * the run tier is not dropped — the runner records it as `skipped-tier` so the
 * skip is visible, and this predicate is what it keys that decision on.
 */
export function tierRunnable(analyzerTier: Tier, runTier: Tier): boolean {
  if (analyzerTier === "cpu") return true;
  if (analyzerTier === "gpu") return runTier === "gpu" || runTier === "full";
  return runTier === "full";
}
