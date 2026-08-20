#!/usr/bin/env bun
/**
 * Per-plugin keyless-e2e coverage gate.
 *
 * A plugin that exposes an agent surface (actions and/or a message connector)
 * but ships zero keyless ("pr-deterministic") e2e coverage is a broken
 * pipeline: a capability users reach with no zero-cost regression test. This
 * gate flags exactly that, ratcheted against a checked-in baseline.
 *
 * Rules:
 *   - Every plugin with a surface must either have a keyless scenario or be in
 *     the baseline `knownUncovered` list.
 *   - The baseline may only SHRINK. A baseline entry that is now covered, or no
 *     longer has a surface / no longer exists, must be removed — the gate fails
 *     until it is, so coverage never silently regresses.
 *   - A plugin with a surface that is neither covered nor in the baseline fails
 *     the gate (newly-uncovered surface).
 *
 * Usage:
 *   bun packages/scripts/e2e-coverage/check-e2e-coverage.ts
 *   bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --list-uncovered
 *   bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --json
 *
 * Exit codes: 0 = gate passes, 1 = gate fails.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginCoverage, type PluginCoverage } from "./inventory.ts";
import {
  buildSyntheticWorldInventory,
  discoverRuntimeSurfaces,
  evaluateSyntheticWorldDrift,
  loadSyntheticWorldManifest,
  type SyntheticWorldDrift,
} from "./synthetic-world-inventory.ts";

const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "keyless-e2e-baseline.json",
);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SYNTHETIC_WORLD_MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "synthetic-world-manifest.json",
);

interface Baseline {
  knownUncovered: string[];
}

export interface CoverageGateResult {
  /** Surface plugins with neither keyless coverage nor a baseline entry. */
  newlyUncovered: string[];
  /** Baseline entries that are now covered (must be removed). */
  staleCovered: string[];
  /** Baseline entries that no longer have a surface / no longer exist. */
  staleMissing: string[];
  ok: boolean;
  /** Canonical all-surface drift gate introduced by #22897. */
  syntheticWorld?: SyntheticWorldDrift;
}

export function loadBaseline(): Baseline {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    knownUncovered?: unknown;
  };
  const knownUncovered = Array.isArray(parsed.knownUncovered)
    ? parsed.knownUncovered.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return { knownUncovered };
}

export function evaluateCoverage(
  coverage: PluginCoverage[],
  baseline: Baseline,
): CoverageGateResult {
  const baselineSet = new Set(baseline.knownUncovered);
  const surfaceByDir = new Map(coverage.map((c) => [c.dir, c]));

  const newlyUncovered = coverage
    .filter((c) => c.hasSurface && !c.hasKeylessE2e && !baselineSet.has(c.dir))
    .map((c) => c.dir)
    .sort();

  const staleCovered: string[] = [];
  const staleMissing: string[] = [];
  for (const dir of baseline.knownUncovered) {
    const entry = surfaceByDir.get(dir);
    if (!entry?.hasSurface) {
      staleMissing.push(dir);
      continue;
    }
    if (entry.hasKeylessE2e) {
      staleCovered.push(dir);
    }
  }

  return {
    newlyUncovered,
    staleCovered: staleCovered.sort(),
    staleMissing: staleMissing.sort(),
    ok:
      newlyUncovered.length === 0 &&
      staleCovered.length === 0 &&
      staleMissing.length === 0,
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const coverage = buildPluginCoverage();

  if (args.includes("--list-uncovered")) {
    const uncovered = coverage
      .filter((c) => c.hasSurface && !c.hasKeylessE2e)
      .map((c) => c.dir)
      .sort();
    process.stdout.write(`${JSON.stringify(uncovered, null, 2)}\n`);
    return 0;
  }

  const baseline = loadBaseline();
  const legacyResult = evaluateCoverage(coverage, baseline);
  const registrations = discoverRuntimeSurfaces(REPO_ROOT);
  const syntheticWorldManifest = loadSyntheticWorldManifest(
    SYNTHETIC_WORLD_MANIFEST_PATH,
  );
  const syntheticWorld = evaluateSyntheticWorldDrift(
    registrations,
    syntheticWorldManifest,
    REPO_ROOT,
  );
  const result: CoverageGateResult = {
    ...legacyResult,
    syntheticWorld,
    ok: legacyResult.ok && syntheticWorld.ok,
  };

  if (args.includes("--json")) {
    const inventory = buildSyntheticWorldInventory(
      REPO_ROOT,
      syntheticWorldManifest,
      new Date().toISOString(),
    );
    process.stdout.write(
      `${JSON.stringify({ ...result, inventory }, null, 2)}\n`,
    );
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    const covered = coverage.filter(
      (c) => c.hasSurface && c.hasKeylessE2e,
    ).length;
    process.stdout.write(
      `[e2e-coverage] OK — canonical inventory has ${registrations.length} registered surface(s) with explicit dispositions; ${covered} legacy action/connector plugin(s) have keyless e2e; ${baseline.knownUncovered.length} legacy gaps remain baselined.\n`,
    );
    return 0;
  }

  if (result.newlyUncovered.length > 0) {
    process.stderr.write(
      `[e2e-coverage] FAIL — ${result.newlyUncovered.length} plugin(s) expose actions/connectors but have no keyless e2e and are not baselined:\n  ${result.newlyUncovered.join("\n  ")}\nAdd a keyless (lane: "pr-deterministic") scenario, or add the plugin to keyless-e2e-baseline.json with justification.\n`,
    );
  }
  if (result.staleCovered.length > 0) {
    process.stderr.write(
      `[e2e-coverage] FAIL — ${result.staleCovered.length} baselined plugin(s) now HAVE keyless e2e; remove them from keyless-e2e-baseline.json (the baseline may only shrink):\n  ${result.staleCovered.join("\n  ")}\n`,
    );
  }
  if (result.staleMissing.length > 0) {
    process.stderr.write(
      `[e2e-coverage] FAIL — ${result.staleMissing.length} baselined plugin(s) no longer expose a surface or no longer exist; remove them from keyless-e2e-baseline.json:\n  ${result.staleMissing.join("\n  ")}\n`,
    );
  }
  if (!syntheticWorld.ok) {
    if (syntheticWorld.newlyUncovered.length > 0) {
      process.stderr.write(
        `[synthetic-world] FAIL — ${syntheticWorld.newlyUncovered.length} newly registered surface(s) have no explicit disposition:\n  ${syntheticWorld.newlyUncovered.join("\n  ")}\nAdd executable boundary evidence or a reviewed, written status; never regenerate the baseline merely to silence drift.\n`,
      );
    }
    if (syntheticWorld.stale.length > 0) {
      process.stderr.write(
        `[synthetic-world] FAIL — ${syntheticWorld.stale.length} stale disposition(s) must be removed (the baseline may only shrink):\n  ${syntheticWorld.stale.join("\n  ")}\n`,
      );
    }
    if (syntheticWorld.invalid.length > 0) {
      process.stderr.write(
        `[synthetic-world] FAIL — ${syntheticWorld.invalid.length} invalid disposition(s) lack a written reason or executable boundary signal:\n  ${syntheticWorld.invalid.join("\n  ")}\n`,
      );
    }
    if (syntheticWorld.omittedPackages.length > 0) {
      process.stderr.write(
        `[synthetic-world] FAIL — ${syntheticWorld.omittedPackages.length} maintained plugin manifest(s) have no discoverable production TypeScript entrypoint:\n  ${syntheticWorld.omittedPackages.join("\n  ")}\nDeclare an eliza-source export or a root/src index entry; packages may not disappear from the inventory silently.\n`,
      );
    }
  }
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
