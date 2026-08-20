#!/usr/bin/env bun
/**
 * Enforces the synthetic-world runtime-surface inventory ratchet. Production
 * registrations may only be covered by executable artifacts with exact
 * boundary signals or by a pre-existing explicit classification; newly added,
 * stale, silently covered, malformed, or duplicate rows fail the gate.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeSurfaceInventory,
  discoverRuntimeSurfaces,
  loadRuntimeSurfaceBaseline,
  RUNTIME_SURFACE_STATUSES,
  type RuntimeSurfaceBaseline,
  type RuntimeSurfaceInventory,
  type RuntimeSurfaceStatus,
} from "./runtime-surface-inventory.ts";

export interface RuntimeSurfaceGateResult {
  newlyUnclassified: string[];
  staleClassifications: string[];
  silentlyCovered: string[];
  invalidClassifications: string[];
  invalidCoverage: string[];
  duplicateRows: string[];
  ok: boolean;
}

function validReason(reason: string): boolean {
  const trimmed = reason.trim();
  return (
    trimmed.length >= 24 &&
    !/^(?:todo|tbd|n\/a|unknown|fixme)(?:\b|\s|[-:])/i.test(trimmed)
  );
}

export function evaluateRuntimeSurfaceCoverage(
  inventory: RuntimeSurfaceInventory,
  baseline: RuntimeSurfaceBaseline,
): RuntimeSurfaceGateResult {
  const rowIds = new Set<string>();
  const duplicateRows: string[] = [];
  for (const row of inventory.rows) {
    if (rowIds.has(row.id)) duplicateRows.push(row.id);
    rowIds.add(row.id);
  }

  const newlyUnclassified = inventory.rows
    .filter(
      (row) => row.status !== "covered" && !baseline.classifications[row.id],
    )
    .map((row) => row.id)
    .sort();

  const staleClassifications = Object.keys(baseline.classifications)
    .filter((id) => !rowIds.has(id))
    .sort();

  const silentlyCovered = inventory.rows
    .filter(
      (row) =>
        row.status === "covered" && Boolean(baseline.classifications[row.id]),
    )
    .map((row) => row.id)
    .sort();

  const validStatuses = new Set<RuntimeSurfaceStatus>(RUNTIME_SURFACE_STATUSES);
  const invalidClassifications = Object.entries(baseline.classifications)
    .filter(
      ([, classification]) =>
        (classification.status as string) === "covered" ||
        !validStatuses.has(classification.status) ||
        !validReason(classification.reason),
    )
    .map(([id]) => id)
    .sort();

  const invalidCoverage = inventory.rows
    .filter(
      (row) =>
        row.status === "covered" &&
        (row.boundaryArtifacts.length === 0 ||
          row.boundarySignals.length === 0 ||
          row.deterministicScenarioIds.length + row.cloudE2eCells.length === 0),
    )
    .map((row) => row.id)
    .sort();

  return {
    newlyUnclassified,
    staleClassifications,
    silentlyCovered,
    invalidClassifications,
    invalidCoverage,
    duplicateRows: [...new Set(duplicateRows)].sort(),
    ok:
      newlyUnclassified.length === 0 &&
      staleClassifications.length === 0 &&
      silentlyCovered.length === 0 &&
      invalidClassifications.length === 0 &&
      invalidCoverage.length === 0 &&
      duplicateRows.length === 0,
  };
}

export function candidateClassification(
  kind: string,
  platformRequirements: readonly string[],
  externalDependencies: readonly string[],
): { status: Exclude<RuntimeSurfaceStatus, "covered">; reason: string } {
  if (
    kind === "native-bridge" ||
    platformRequirements.includes("native-host")
  ) {
    return {
      status: "platform-deferred",
      reason:
        "Requires a supported native host or device target; deterministic platform composition is tracked by #22904.",
    };
  }
  if (kind === "model-handler") {
    return {
      status: "provider-qualified-only",
      reason:
        "Real provider qualification remains fail-closed; strict deterministic model fixtures are tracked by #22901.",
    };
  }
  if (
    externalDependencies.length > 0 &&
    ["provider", "connector-ingress", "connector-egress"].includes(kind)
  ) {
    return {
      status: "provider-qualified-only",
      reason:
        "The external protocol boundary lacks a resettable production-client mock; protocol fidelity is tracked by #22899.",
    };
  }
  return {
    status: "exempt",
    reason:
      "No boundary-specific executable synthetic-world artifact exists yet; implementation is assigned to the row's dependency workstream.",
  };
}

function printFailures(result: RuntimeSurfaceGateResult): void {
  const groups: Array<[keyof RuntimeSurfaceGateResult, string]> = [
    [
      "newlyUnclassified",
      "new production surfaces need an explicit implementation or disposition",
    ],
    [
      "staleClassifications",
      "baseline rows no longer exist and must be removed",
    ],
    [
      "silentlyCovered",
      "covered rows remain baselined; the baseline may only shrink",
    ],
    [
      "invalidClassifications",
      "classifications have an invalid status or non-actionable reason",
    ],
    [
      "invalidCoverage",
      "covered rows lack an executable artifact and exact boundary signal",
    ],
    ["duplicateRows", "duplicate canonical row ids were generated"],
  ];
  for (const [key, description] of groups) {
    const values = result[key];
    if (!Array.isArray(values) || values.length === 0) continue;
    process.stderr.write(
      `\n[runtime-surfaces] ${description}:\n  ${values.join("\n  ")}\n`,
    );
  }
}

function main(): number {
  const args = process.argv.slice(2);
  const baselineFile = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "runtime-surface-baseline.json",
  );
  if (args.includes("--list-registrations")) {
    process.stdout.write(
      `${JSON.stringify(discoverRuntimeSurfaces(), null, 2)}\n`,
    );
    return 0;
  }
  const baseline = loadRuntimeSurfaceBaseline(baselineFile);
  const inventory = buildRuntimeSurfaceInventory({ baseline });
  const result = evaluateRuntimeSurfaceCoverage(inventory, baseline);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ result, inventory }, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `[runtime-surfaces] OK — ${inventory.summary.total} registered surfaces; ` +
        `${inventory.summary.byStatus.covered ?? 0} covered; ` +
        `${Object.keys(baseline.classifications).length} explicitly classified.\n`,
    );
  } else {
    printFailures(result);
  }
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main());
