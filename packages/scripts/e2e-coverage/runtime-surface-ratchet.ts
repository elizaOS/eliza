/**
 * Enforces the reviewed synthetic-world gap baseline against the canonical
 * production runtime-surface inventory. The baseline records exact surface
 * identities and statuses under an owning workstream so existing debt may
 * shrink but a new or reclassified gap cannot be accepted silently.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RUNTIME_SURFACE_REPO_ROOT,
  type RuntimeSurfaceInventory,
  type RuntimeSurfaceRow,
  type RuntimeSurfaceStatus,
} from "./runtime-surface-inventory.ts";

export const RUNTIME_SURFACE_RATCHET_SCHEMA =
  "eliza.synthetic-world-surface-ratchet/v1";

export type RuntimeSurfaceGapStatus = Exclude<RuntimeSurfaceStatus, "covered">;

export interface RuntimeSurfaceGapBaselineEntry {
  id: string;
  status: RuntimeSurfaceGapStatus;
}

export interface RuntimeSurfaceGapBaselineGroup {
  workstream: RuntimeSurfaceRow["workstream"];
  reason: string;
  surfaces: RuntimeSurfaceGapBaselineEntry[];
}

export interface RuntimeSurfaceGapBaseline {
  schema: typeof RUNTIME_SURFACE_RATCHET_SCHEMA;
  foundation: {
    pullRequest: number;
    head: string;
  };
  initializedAgainst: {
    developHead: string;
    rowFingerprint: string;
  };
  deferrals: RuntimeSurfaceGapBaselineGroup[];
}

export interface RuntimeSurfaceGapChange {
  id: string;
  baselineStatus: RuntimeSurfaceGapStatus;
  currentStatus: RuntimeSurfaceGapStatus;
  baselineWorkstream: RuntimeSurfaceRow["workstream"];
  currentWorkstream: RuntimeSurfaceRow["workstream"];
}

export interface RuntimeSurfaceRatchetResult {
  newGaps: string[];
  resolvedGaps: string[];
  changedGaps: RuntimeSurfaceGapChange[];
  ok: boolean;
}

const DEFAULT_BASELINE_FILE = path.join(
  RUNTIME_SURFACE_REPO_ROOT,
  "packages/scripts/e2e-coverage/runtime-surface-gap-baseline.json",
);

const OWNED_WORKSTREAMS = new Set<RuntimeSurfaceRow["workstream"]>([
  "#22898",
  "#22899",
  "#22901",
  "#22902",
  "#22904",
  "#23268",
  "#23270",
]);

function isGapStatus(value: unknown): value is RuntimeSurfaceGapStatus {
  return (
    typeof value === "string" &&
    [
      "uncovered",
      "exempt",
      "platform-deferred",
      "provider-qualified-only",
      "unsupported-product",
    ].includes(value)
  );
}

function parseRuntimeSurfaceGapBaseline(
  value: unknown,
  source: string,
): RuntimeSurfaceGapBaseline {
  if (!value || typeof value !== "object") {
    throw new Error(`Runtime-surface gap baseline is not an object: ${source}`);
  }
  const baseline = value as Partial<RuntimeSurfaceGapBaseline>;
  if (
    baseline.schema !== RUNTIME_SURFACE_RATCHET_SCHEMA ||
    !baseline.foundation ||
    baseline.foundation.pullRequest !== 24084 ||
    !/^[0-9a-f]{40}$/.test(baseline.foundation.head ?? "") ||
    !baseline.initializedAgainst ||
    !/^[0-9a-f]{40}$/.test(baseline.initializedAgainst.developHead ?? "") ||
    !/^[0-9a-f]{64}$/.test(baseline.initializedAgainst.rowFingerprint ?? "") ||
    !Array.isArray(baseline.deferrals)
  ) {
    throw new Error(`Invalid runtime-surface gap baseline header: ${source}`);
  }

  const seen = new Set<string>();
  let previousWorkstream = "";
  for (const group of baseline.deferrals) {
    if (
      !group ||
      typeof group !== "object" ||
      !/^#\d+$/.test(group.workstream ?? "") ||
      !OWNED_WORKSTREAMS.has(group.workstream) ||
      typeof group.reason !== "string" ||
      group.reason.trim().length < 24 ||
      !Array.isArray(group.surfaces) ||
      group.surfaces.length === 0 ||
      group.workstream <= previousWorkstream
    ) {
      throw new Error(
        `Invalid or unsorted runtime-surface deferral group: ${source}`,
      );
    }
    previousWorkstream = group.workstream;
    let previousId = "";
    for (const surface of group.surfaces) {
      if (
        !surface ||
        typeof surface !== "object" ||
        typeof surface.id !== "string" ||
        surface.id.length === 0 ||
        surface.id <= previousId ||
        seen.has(surface.id) ||
        !isGapStatus(surface.status)
      ) {
        throw new Error(
          `Invalid, duplicate, or unsorted runtime-surface deferral: ${source}`,
        );
      }
      previousId = surface.id;
      seen.add(surface.id);
    }
  }
  return baseline as RuntimeSurfaceGapBaseline;
}

export function loadRuntimeSurfaceGapBaseline(
  file = DEFAULT_BASELINE_FILE,
): RuntimeSurfaceGapBaseline {
  return parseRuntimeSurfaceGapBaseline(
    JSON.parse(readFileSync(file, "utf8")) as unknown,
    file,
  );
}

export function evaluateRuntimeSurfaceRatchet(
  inventory: RuntimeSurfaceInventory,
  baseline: RuntimeSurfaceGapBaseline,
): RuntimeSurfaceRatchetResult {
  const currentRows = new Map(inventory.rows.map((row) => [row.id, row]));
  const accepted = new Map<
    string,
    {
      status: RuntimeSurfaceGapStatus;
      workstream: RuntimeSurfaceRow["workstream"];
    }
  >();
  for (const group of baseline.deferrals) {
    for (const surface of group.surfaces) {
      accepted.set(surface.id, {
        status: surface.status,
        workstream: group.workstream,
      });
    }
  }

  const newGaps = inventory.rows
    .filter((row) => row.status !== "covered" && !accepted.has(row.id))
    .map((row) => row.id)
    .sort();
  const resolvedGaps = [...accepted.keys()]
    .filter((id) => {
      const row = currentRows.get(id);
      return !row || row.status === "covered";
    })
    .sort();
  const changedGaps: RuntimeSurfaceGapChange[] = [];
  for (const [id, expected] of accepted) {
    const row = currentRows.get(id);
    if (!row || row.status === "covered") continue;
    if (
      row.status !== expected.status ||
      row.workstream !== expected.workstream
    ) {
      changedGaps.push({
        id,
        baselineStatus: expected.status,
        currentStatus: row.status,
        baselineWorkstream: expected.workstream,
        currentWorkstream: row.workstream,
      });
    }
  }
  changedGaps.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  return {
    newGaps,
    resolvedGaps,
    changedGaps,
    ok:
      newGaps.length === 0 &&
      resolvedGaps.length === 0 &&
      changedGaps.length === 0,
  };
}
