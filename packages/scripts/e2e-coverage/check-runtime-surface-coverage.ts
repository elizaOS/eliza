#!/usr/bin/env bun
/**
 * Reports the production runtime-surface census, optionally compares generated
 * reports within named package scopes, and enforces the reviewed gap ratchet
 * when explicitly requested by the audit command.
 */

import { readFileSync } from "node:fs";
import {
  buildRuntimeSurfaceInventory,
  type RuntimeSurfaceInventory,
  type RuntimeSurfaceRow,
} from "./runtime-surface-inventory.ts";
import {
  evaluateRuntimeSurfaceRatchet,
  loadRuntimeSurfaceGapBaseline,
} from "./runtime-surface-ratchet.ts";

export interface RuntimeSurfaceHealth {
  duplicateRows: string[];
  invalidCoverage: string[];
  coveredWithoutMockOwner: string[];
  ok: boolean;
}

export interface RuntimeSurfaceScopedDrift {
  packages: string[];
  added: string[];
  removed: string[];
  changed: string[];
}

interface CliOptions {
  enforce: boolean;
  json: boolean;
  compareFile: string | null;
  packages: string[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    enforce: false,
    json: false,
    compareFile: null,
    packages: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--enforce") {
      options.enforce = true;
    } else if (argument === "--compare") {
      options.compareFile = args[++index] ?? null;
    } else if (argument === "--package") {
      const packageName = args[++index];
      if (packageName) options.packages.push(packageName);
    } else {
      throw new Error(`Unknown runtime-surface report option: ${argument}`);
    }
  }
  if (options.compareFile && options.packages.length === 0) {
    throw new Error("--compare requires at least one explicit --package scope");
  }
  return options;
}

export function inspectRuntimeSurfaceHealth(
  inventory: RuntimeSurfaceInventory,
): RuntimeSurfaceHealth {
  const seen = new Set<string>();
  const duplicateRows = new Set<string>();
  for (const row of inventory.rows) {
    if (seen.has(row.id)) duplicateRows.add(row.id);
    seen.add(row.id);
  }
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
  const coveredWithoutMockOwner = inventory.rows
    .filter(
      (row) =>
        row.status === "covered" &&
        (row.dependencyDisposition === "mock-missing" ||
          row.dependencyDisposition === "unresolved"),
    )
    .map((row) => row.id)
    .sort();
  return {
    duplicateRows: [...duplicateRows].sort(),
    invalidCoverage,
    coveredWithoutMockOwner,
    ok:
      duplicateRows.size === 0 &&
      invalidCoverage.length === 0 &&
      coveredWithoutMockOwner.length === 0,
  };
}

function comparableRow(row: RuntimeSurfaceRow): string {
  return JSON.stringify({
    kind: row.kind,
    surfaceName: row.surfaceName,
    packageName: row.packageName,
    sourcePath: row.sourcePath,
    registrationField: row.registrationField,
    externalServiceDependencies: row.externalServiceDependencies,
    mockDependencies: row.mockDependencies,
    dependencyDisposition: row.dependencyDisposition,
    deterministicScenarioIds: row.deterministicScenarioIds,
    liveModelScenarioIds: row.liveModelScenarioIds,
    cloudE2eCells: row.cloudE2eCells,
    evidenceClass: row.evidenceClass,
    boundaryArtifacts: row.boundaryArtifacts,
    boundarySignals: row.boundarySignals,
    status: row.status,
  });
}

export function compareRuntimeSurfaceInventories(
  current: RuntimeSurfaceInventory,
  previous: RuntimeSurfaceInventory,
  packageNames: readonly string[],
): RuntimeSurfaceScopedDrift {
  const packages = [...new Set(packageNames)].sort();
  if (packages.length === 0) {
    throw new Error("Runtime-surface drift requires an explicit package scope");
  }
  const scope = new Set(packages);
  const scoped = (inventory: RuntimeSurfaceInventory): Map<string, string> =>
    new Map(
      inventory.rows
        .filter((row) => scope.has(row.packageName))
        .map((row) => [row.id, comparableRow(row)]),
    );
  const currentRows = scoped(current);
  const previousRows = scoped(previous);
  return {
    packages,
    added: [...currentRows.keys()].filter((id) => !previousRows.has(id)).sort(),
    removed: [...previousRows.keys()]
      .filter((id) => !currentRows.has(id))
      .sort(),
    changed: [...currentRows.keys()]
      .filter(
        (id) =>
          previousRows.has(id) && previousRows.get(id) !== currentRows.get(id),
      )
      .sort(),
  };
}

function readInventory(file: string): RuntimeSurfaceInventory {
  const parsed = JSON.parse(
    readFileSync(file, "utf8"),
  ) as RuntimeSurfaceInventory;
  if (
    !parsed ||
    !Array.isArray(parsed.rows) ||
    typeof parsed.schema !== "string"
  ) {
    throw new Error(`Invalid runtime-surface report: ${file}`);
  }
  return parsed;
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  const inventory = buildRuntimeSurfaceInventory();
  const health = inspectRuntimeSurfaceHealth(inventory);
  const ratchet = options.enforce
    ? evaluateRuntimeSurfaceRatchet(inventory, loadRuntimeSurfaceGapBaseline())
    : null;
  const drift = options.compareFile
    ? compareRuntimeSurfaceInventories(
        inventory,
        readInventory(options.compareFile),
        options.packages,
      )
    : null;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ inventory, health, ratchet, drift }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `[runtime-surfaces] REPORT — ${inventory.summary.total} registered; ` +
        `${inventory.summary.byStatus.covered ?? 0} covered; ` +
        `${inventory.summary.byStatus.uncovered ?? 0} uncovered; ` +
        `${health.ok ? "structurally valid" : "structural findings present"}.\n`,
    );
    if (drift) {
      process.stdout.write(
        `[runtime-surfaces] scoped drift — ${drift.packages.join(", ")}: ` +
          `+${drift.added.length} -${drift.removed.length} ~${drift.changed.length}.\n`,
      );
    }
    if (ratchet) {
      process.stdout.write(
        `[runtime-surfaces] ${ratchet.ok ? "PASS" : "FAIL"} ratchet — ` +
          `${ratchet.newGaps.length} new; ${ratchet.resolvedGaps.length} resolved; ` +
          `${ratchet.changedGaps.length} reclassified.\n`,
      );
      for (const id of ratchet.newGaps) {
        process.stdout.write(`  new gap: ${id}\n`);
      }
      for (const id of ratchet.resolvedGaps) {
        process.stdout.write(`  remove resolved baseline entry: ${id}\n`);
      }
      for (const change of ratchet.changedGaps) {
        process.stdout.write(
          `  review changed gap: ${change.id} ` +
            `(${change.baselineStatus}/${change.baselineWorkstream} -> ` +
            `${change.currentStatus}/${change.currentWorkstream})\n`,
        );
      }
    }
  }
  return options.enforce && (!health.ok || !ratchet?.ok) ? 1 : 0;
}

if (import.meta.main) process.exit(main());
