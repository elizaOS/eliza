#!/usr/bin/env bun
/**
 * Bootstraps the reviewed synthetic-world disposition manifest from the current production inventory.
 * This command is deliberately separate from the CI gate: normal audits never mutate the baseline,
 * and reviewers must inspect any bootstrap diff before accepting a newly classified surface.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_ROUTE_COVERAGE } from "./manifest.ts";
import {
  discoverRuntimeSurfaces,
  isExecutableBoundaryEvidence,
  type SurfaceDisposition,
  type SurfaceRegistration,
  SYNTHETIC_WORLD_SCHEMA,
  type SyntheticWorldManifest,
} from "./synthetic-world-inventory.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const OUTPUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "synthetic-world-manifest.json",
);

interface ScenarioEvidence {
  id: string;
  artifact: string;
  keyless: boolean;
  pluginRefs: string[];
  source: string;
}

function walk(root: string, output: string[] = []): string[] {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "dist", ".turbo", ".git"].includes(entry.name))
      continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (entry.isFile() && entry.name.endsWith(".scenario.ts"))
      output.push(full);
  }
  return output;
}

function scenarios(): ScenarioEvidence[] {
  return walk(REPO_ROOT).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    const id = source.match(/\bid\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (!id) return [];
    const plugins =
      source.match(
        /\brequires\s*:\s*{[\s\S]{0,2000}?\bplugins\s*:\s*\[([\s\S]*?)\]/,
      )?.[1] ?? "";
    return [
      {
        id,
        artifact: path.relative(REPO_ROOT, file),
        keyless: isKeylessScenarioSource(source),
        pluginRefs: [...plugins.matchAll(/["'`]([^"'`]+)["'`]/g)].map(
          (match) => match[1],
        ),
        source,
      },
    ];
  });
}

/** The schema default is live-only; directory placement never promotes a scenario to PR coverage. */
export function isKeylessScenarioSource(source: string): boolean {
  return /\blane\s*:\s*["'`]pr-deterministic["'`]/.test(source);
}

function pluginAliases(row: SurfaceRegistration): string[] {
  const dir = row.source.startsWith("plugins/") ? row.source.split("/")[1] : "";
  return [row.packageName, dir, dir.replace(/^plugin-/, "")].filter(Boolean);
}

function boundarySignal(row: SurfaceRegistration): string {
  return row.kind === "subaction"
    ? (row.name.split("/").at(-1) ?? row.name)
    : row.name;
}

function scenarioDisposition(
  row: SurfaceRegistration,
  evidence: ScenarioEvidence[],
): SurfaceDisposition | null {
  const aliases = new Set(pluginAliases(row));
  if (aliases.size === 0) return null;
  const signal = boundarySignal(row);
  const matching = evidence.filter(
    (scenario) =>
      scenario.pluginRefs.some((reference) => aliases.has(reference)) &&
      isExecutableBoundaryEvidence(row, scenario.source),
  );
  const keyless = matching.filter((scenario) => scenario.keyless);
  if (keyless.length === 0) return null;
  const live = matching.filter((scenario) => !scenario.keyless);
  return {
    status: "covered",
    reason:
      "A zero-credential scenario executes the registered surface and asserts its boundary-specific signal.",
    artifacts: [
      ...new Set(keyless.map((scenario) => scenario.artifact)),
    ].sort(),
    boundarySignals:
      row.kind === "connector-egress"
        ? ["connectorDispatchOccurred"]
        : [signal],
    mockFidelity: "shape",
    resetSupport: "process",
    deterministicScenarioIds: keyless.map((scenario) => scenario.id).sort(),
    liveModelScenarioIds: live.map((scenario) => scenario.id).sort(),
    evidenceClass: "simulated",
    workstream: "scenario-corpus",
  };
}

function cloudDisposition(
  row: SurfaceRegistration,
  e2eFiles: Array<{ artifact: string; source: string }>,
): SurfaceDisposition | null {
  if (!row.source.startsWith("packages/cloud/")) return null;
  const signal = boundarySignal(row);
  const matches = e2eFiles.filter((file) =>
    isExecutableBoundaryEvidence(row, file.source),
  );
  if (matches.length === 0) return null;
  return {
    status: "covered",
    reason:
      "A Cloud full-stack E2E cell crosses the production route or service boundary against the local mock-backed stack.",
    artifacts: matches.map((match) => match.artifact).sort(),
    boundarySignals: [signal],
    cloudE2eCells: matches.map((match) => path.basename(match.artifact)).sort(),
    mockFidelity: "stateful",
    resetSupport: "world-reset",
    evidenceClass: "simulated",
    workstream: "cloud-e2e",
  };
}

function routeDisposition(row: SurfaceRegistration): SurfaceDisposition | null {
  if (row.kind !== "route" || !row.source.startsWith("plugins/")) return null;
  const plugin = row.source.split("/")[1];
  const entry = PLUGIN_ROUTE_COVERAGE[plugin];
  if (entry?.status !== "covered" || entry.signals.length === 0) return null;
  const provingArtifacts = entry.artifacts.filter((artifact) => {
    const file = path.join(REPO_ROOT, artifact);
    return (
      existsSync(file) &&
      isExecutableBoundaryEvidence(row, readFileSync(file, "utf8"))
    );
  });
  if (provingArtifacts.length === 0) return null;
  return {
    status: "covered",
    reason:
      entry.note ??
      "The executable route artifact boots the production plugin dispatcher and verifies this registered route family.",
    artifacts: provingArtifacts,
    boundarySignals: [...new Set([...entry.signals, row.name])],
    mockFidelity: "shape",
    resetSupport: "process",
    evidenceClass: "simulated",
    workstream: "plugin-route-e2e",
  };
}

function gapDisposition(row: SurfaceRegistration): SurfaceDisposition {
  if (row.kind === "native-bridge" || row.platformRequirements.length > 0) {
    return {
      status: "platform-deferred",
      reason: `This registered surface requires ${row.platformRequirements.join(", ") || "a native runtime"}; its hardware-independent contract still needs a deterministic synthetic adapter and executable scenario.`,
      mockFidelity: "none",
      resetSupport: "none",
      workstream: "native-platform-mocks",
    };
  }
  if (
    row.kind.startsWith("connector-") ||
    row.externalDependencies.length > 0
  ) {
    return {
      status: "provider-qualified-only",
      reason:
        "This provider-facing surface currently has only live/provider evidence; #22899 must add a protocol-faithful, resettable mock and keyless boundary scenario.",
      mockFidelity: "none",
      resetSupport: "none",
      evidenceClass: "provider-qualified",
      workstream: "provider-mocks-22899",
    };
  }
  return {
    status: "exempt",
    reason:
      "Grandfathered pre-inventory coverage debt: no executable keyless artifact currently proves this exact registered boundary; the exemption is surface-specific and may only be removed by adding evidence.",
    mockFidelity: "none",
    resetSupport: "none",
    workstream:
      row.kind === "worker" || row.kind === "queue"
        ? "background-services-22902"
        : row.source.startsWith("packages/cloud/")
          ? "cloud-matrix-22904"
          : "scenario-coverage-22897",
  };
}

function build(): SyntheticWorldManifest {
  const evidence = scenarios();
  const e2eFiles = walk(
    path.join(REPO_ROOT, "packages", "cloud", "e2e", "tests"),
  )
    .filter((file) => file.endsWith(".spec.ts"))
    .map((file) => ({
      artifact: path.relative(REPO_ROOT, file),
      source: readFileSync(file, "utf8"),
    }));
  const dispositions: Record<string, SurfaceDisposition> = {};
  for (const row of discoverRuntimeSurfaces(REPO_ROOT)) {
    dispositions[row.id] =
      scenarioDisposition(row, evidence) ??
      cloudDisposition(row, e2eFiles) ??
      routeDisposition(row) ??
      gapDisposition(row);
  }
  return { schema: SYNTHETIC_WORLD_SCHEMA, dispositions };
}

if (import.meta.main) {
  if (!process.argv.includes("--bootstrap-reviewed-baseline")) {
    process.stderr.write(
      "Refusing to rewrite the ratchet without --bootstrap-reviewed-baseline. Normal CI uses check-e2e-coverage.ts and never updates this file.\n",
    );
    process.exit(2);
  }

  writeFileSync(OUTPUT, `${JSON.stringify(build(), null, 2)}\n`);
  process.stdout.write(
    `Wrote ${path.relative(REPO_ROOT, OUTPUT)}. Review every added disposition; never use this command to silence drift.\n`,
  );
}
