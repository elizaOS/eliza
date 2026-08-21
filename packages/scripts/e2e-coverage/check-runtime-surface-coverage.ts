#!/usr/bin/env bun
/**
 * Enforces the synthetic-world runtime-surface inventory ratchet. Production
 * registrations may only be covered by executable artifacts with exact
 * boundary signals or by a pre-existing explicit classification; newly added,
 * stale, silently covered, malformed, or duplicate rows fail the gate.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeSurfaceInventory,
  discoverRuntimeSurfaces,
  loadRuntimeSurfaceBaseline,
  RUNTIME_SURFACE_SCHEMA,
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
  unclassifiedPackages: string[];
  stalePackageClassifications: string[];
  invalidPackageClassifications: string[];
  overbroadClassificationReasons: string[];
  ok: boolean;
}

function validReason(reason: string): boolean {
  const trimmed = reason.trim();
  return (
    trimmed.length >= 24 &&
    !/^(?:todo|tbd|n\/a|unknown|unreviewed|fixme)(?:\b|\s|[-:])/i.test(trimmed)
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
  const zeroSurfacePackages = inventory.packages
    .filter((entry) => entry.registrationState === "no-runtime-registration")
    .map((entry) => entry.packageDir)
    .sort();
  const unclassifiedPackages = zeroSurfacePackages.filter(
    (packageDir) => !baseline.packageClassifications[packageDir],
  );
  const stalePackageClassifications = Object.keys(
    baseline.packageClassifications,
  )
    .filter((packageDir) => !zeroSurfacePackages.includes(packageDir))
    .sort();
  const invalidPackageClassifications = Object.entries(
    baseline.packageClassifications,
  )
    .filter(
      ([, classification]) =>
        classification.status !== "no-runtime-registration" ||
        !validReason(classification.reason),
    )
    .map(([packageDir]) => packageDir)
    .sort();
  const reasonCounts = new Map<string, number>();
  for (const classification of Object.values(baseline.classifications)) {
    reasonCounts.set(
      classification.reason,
      (reasonCounts.get(classification.reason) ?? 0) + 1,
    );
  }
  const overbroadClassificationReasons = [...reasonCounts.entries()]
    .filter(([, count]) => count > 8)
    .map(([reason, count]) => `${count}x ${reason}`)
    .sort();

  return {
    newlyUnclassified,
    staleClassifications,
    silentlyCovered,
    invalidClassifications,
    invalidCoverage,
    duplicateRows: [...new Set(duplicateRows)].sort(),
    unclassifiedPackages,
    stalePackageClassifications,
    invalidPackageClassifications,
    overbroadClassificationReasons,
    ok:
      newlyUnclassified.length === 0 &&
      staleClassifications.length === 0 &&
      silentlyCovered.length === 0 &&
      invalidClassifications.length === 0 &&
      invalidCoverage.length === 0 &&
      duplicateRows.length === 0 &&
      unclassifiedPackages.length === 0 &&
      stalePackageClassifications.length === 0 &&
      invalidPackageClassifications.length === 0 &&
      overbroadClassificationReasons.length === 0,
  };
}

export function candidateClassification(
  kind: string,
  platformRequirements: readonly string[],
  externalDependencies: readonly string[],
  context?: { packageName: string; surfaceName: string; workstream: string },
): { status: Exclude<RuntimeSurfaceStatus, "covered">; reason: string } {
  const subject = context
    ? `${context.packageName} ${kind} "${context.surfaceName}"`
    : `This ${kind} surface`;
  const workstream = context?.workstream ?? "its dependency workstream";
  if (
    kind === "native-bridge" ||
    platformRequirements.includes("native-host")
  ) {
    return {
      status: "platform-deferred",
      reason: `${subject} requires a supported native host or device target; deterministic platform composition is tracked by ${workstream}.`,
    };
  }
  if (kind === "model-handler") {
    return {
      status: "provider-qualified-only",
      reason: `${subject} has only real-provider qualification; strict deterministic model fixtures are tracked by ${workstream}.`,
    };
  }
  if (
    externalDependencies.length > 0 &&
    ["provider", "connector-ingress", "connector-egress"].includes(kind)
  ) {
    return {
      status: "provider-qualified-only",
      reason: `${subject} lacks a resettable production-client mock for its external protocol; fidelity is tracked by ${workstream}.`,
    };
  }
  return {
    status: "uncovered",
    reason:
      context?.workstream === "unassigned"
        ? `${subject} has no boundary-specific executable synthetic-world artifact and remains an explicitly unassigned implementation gap.`
        : `${subject} has no boundary-specific executable synthetic-world artifact; implementation is assigned to ${workstream}.`,
  };
}

function bootstrapReviewedBaseline(
  baselineFile: string,
  sourceRevision: string,
): void {
  const reviewedPackageReasons: Record<string, string> = {
    "plugins/plugin-cli":
      "@elizaos/plugin-cli exports Commander command construction, execution, parsing, and CLI utility contracts; its reachable entry graph does not register an AgentRuntime Plugin surface.",
    "plugins/plugin-native-activity-tracker":
      "@elizaos/native-activity-tracker is a Darwin subprocess client that spawns and parses the Swift activity collector; its consumer owns lifecycle wiring and the package registers no AgentRuntime surface.",
    "plugins/plugin-native-reminders":
      "@elizaos/macosreminders exports macOS reminder bridge policy helpers only; it contains no Plugin object, runtime registration call, or native bridge registration entrypoint.",
    "plugins/plugin-native-shared-types":
      "@elizaos/native-plugin-shared-types exports compile-time bridge callback and Web Speech contracts only; its entrypoint has no runtime values or registration side effects.",
  };
  const seed: RuntimeSurfaceBaseline = {
    schema: RUNTIME_SURFACE_SCHEMA,
    generatedFrom: sourceRevision,
    classifications: {},
    packageClassifications: {},
  };
  const inventory = buildRuntimeSurfaceInventory({ baseline: seed });
  const classifications = Object.fromEntries(
    inventory.rows
      .filter((row) => row.status !== "covered")
      .map((row) => [
        row.id,
        candidateClassification(
          row.kind,
          row.platformRequirements,
          row.externalDependencies,
          {
            packageName: row.packageName,
            surfaceName: row.surfaceName,
            workstream: row.workstream,
          },
        ),
      ]),
  );
  const packageClassifications = Object.fromEntries(
    inventory.packages
      .filter((entry) => entry.registrationState === "no-runtime-registration")
      .map((entry) => [
        entry.packageDir,
        {
          status: "no-runtime-registration" as const,
          reason:
            reviewedPackageReasons[entry.packageDir] ??
            `UNREVIEWED zero-surface package ${entry.packageName}; add a package-specific production-entrypoint disposition before committing this baseline.`,
        },
      ]),
  );
  const baseline: RuntimeSurfaceBaseline = {
    schema: RUNTIME_SURFACE_SCHEMA,
    generatedFrom: sourceRevision,
    classifications,
    packageClassifications,
  };
  writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(
    `Wrote reviewed baseline with ${Object.keys(classifications).length} surface classifications and ${Object.keys(packageClassifications).length} package dispositions. Review the complete diff before commit.\n`,
  );
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
    [
      "unclassifiedPackages",
      "zero-surface packages need a reviewed no-runtime disposition",
    ],
    [
      "stalePackageClassifications",
      "package dispositions became stale after surfaces were discovered",
    ],
    [
      "invalidPackageClassifications",
      "package dispositions have an invalid status or reason",
    ],
    [
      "overbroadClassificationReasons",
      "one disposition reason was reused across too many surfaces",
    ],
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
  if (args.includes("--bootstrap-reviewed-baseline")) {
    const sourceRevision =
      args
        .find((arg) => arg.startsWith("--source-revision="))
        ?.slice("--source-revision=".length) ?? "reviewed-working-tree";
    bootstrapReviewedBaseline(baselineFile, sourceRevision);
    return 0;
  }
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
