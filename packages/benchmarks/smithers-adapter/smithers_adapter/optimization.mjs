// GEPA optimization-artifact loading for the single-turn Smithers harness.
//
// `smithers optimize` writes an artifact (default shape `{"patches":[{nodeId,
// prompt,rationale}]}`) that captures evolved prompts. This module resolves an
// optimized *system prompt* from such an artifact so the benchmark harness can
// run with the optimized prompt instead of the benchmark's built-in default —
// the consumable half of Smithers' GEPA self-optimization advantage.
//
// Dependency-free on purpose: it imports nothing from `smithers-orchestrator`,
// so it can be unit-tested with plain node/bun without a Smithers install.

import { readFileSync } from "node:fs";

const pickString = (value) =>
  typeof value === "string" && value.trim() ? value : null;

/**
 * Read and parse an optimization artifact from disk. Returns `null` for a
 * missing/unset path or unreadable/invalid JSON (the harness then falls back to
 * the benchmark's default prompt — a missing artifact must never break a run).
 */
export function loadOptimizationArtifact(path) {
  if (!path || typeof path !== "string") return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve an optimized system prompt for a benchmark from an artifact, trying
 * most-specific to least-specific:
 *   1. `artifact.benchmarks[<benchmark>].systemPrompt` (or `.prompt`)
 *   2. a `patches[]` entry whose `nodeId` equals the benchmark
 *   3. a `patches[]` entry whose `nodeId` is a system-prompt alias
 *   4. `artifact.systemPrompt`
 *   5. the first `patches[]` entry with a usable prompt
 * Returns the prompt string, or `null` when nothing applies.
 */
export function resolveOptimizedSystemPrompt(artifact, benchmark) {
  if (!artifact || typeof artifact !== "object") return null;

  const perBenchmark =
    benchmark && artifact.benchmarks && typeof artifact.benchmarks === "object"
      ? artifact.benchmarks[benchmark]
      : null;
  if (perBenchmark && typeof perBenchmark === "object") {
    const prompt =
      pickString(perBenchmark.systemPrompt) ?? pickString(perBenchmark.prompt);
    if (prompt) return prompt;
  }

  const patches = Array.isArray(artifact.patches) ? artifact.patches : [];
  const patchByNode = (id) =>
    patches.find(
      (p) =>
        p && typeof p === "object" && p.nodeId === id && pickString(p.prompt),
    );

  const systemAliases = ["system", "default", "system_prompt", "systemPrompt"];
  const matched =
    (benchmark ? patchByNode(benchmark) : null) ||
    systemAliases.map(patchByNode).find(Boolean) ||
    null;
  if (matched) return pickString(matched.prompt);

  const global = pickString(artifact.systemPrompt);
  if (global) return global;

  const firstUsable = patches.find(
    (p) => p && typeof p === "object" && pickString(p.prompt),
  );
  return firstUsable ? pickString(firstUsable.prompt) : null;
}
