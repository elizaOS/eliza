#!/usr/bin/env bun
/**
 * Reports the production runtime-surface census and optionally compares two
 * generated reports within explicitly named package scopes. This foundation
 * is advisory: it never turns repository churn into a PR-blocking exit code.
 */

import { readFileSync } from "node:fs";
import {
  buildRuntimeSurfaceInventory,
  type RuntimeSurfaceInventory,
  type RuntimeSurfaceRow,
} from "./runtime-surface-inventory.ts";

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
  json: boolean;
  compareFile: string | null;
  packages: string[];
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false, compareFile: null, packages: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      options.json = true;
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
  const drift = options.compareFile
    ? compareRuntimeSurfaceInventories(
        inventory,
        readInventory(options.compareFile),
        options.packages,
      )
    : null;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ inventory, health, drift }, null, 2)}\n`,
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
  }
  return 0;
}

if (import.meta.main) process.exit(main());
