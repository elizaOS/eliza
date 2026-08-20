/**
 * Exercises the production-registration runtime inventory and its shrinking
 * classification ratchet with the real repository plus deterministic adversarial
 * fixtures. No plugin module, provider client, or external credential is loaded.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  candidateClassification,
  evaluateRuntimeSurfaceCoverage,
} from "./check-runtime-surface-coverage.ts";
import {
  buildRuntimeSurfaceInventory,
  loadRuntimeSurfaceBaseline,
  RUNTIME_SURFACE_REPO_ROOT,
  RUNTIME_SURFACE_SCHEMA,
  RUNTIME_SURFACE_STATUSES,
  type RuntimeSurfaceBaseline,
  type RuntimeSurfaceInventory,
  type RuntimeSurfaceKind,
  type RuntimeSurfaceRow,
  type RuntimeSurfaceStatus,
} from "./runtime-surface-inventory.ts";

function row(
  id: string,
  status: RuntimeSurfaceStatus,
  overrides: Partial<RuntimeSurfaceRow> = {},
): RuntimeSurfaceRow {
  return {
    id,
    kind: "action",
    surfaceName: id,
    owner: "@elizaos/test-owner",
    packageName: "@elizaos/test-package",
    packageDir: "plugins/plugin-test",
    sourcePath: "plugins/plugin-test/src/index.ts",
    registrationField: "actions",
    runtimeRequirements: [],
    platformRequirements: [],
    externalDependencies: [],
    mockAvailability: status === "covered" ? "available" : "missing",
    mockFidelity: "deterministic fixture",
    resetSupport: status === "covered" ? "partial" : "missing",
    deterministicScenarioIds: status === "covered" ? ["fixture-scenario"] : [],
    liveModelScenarioIds: [],
    cloudE2eCells: [],
    evidenceClass: status === "covered" ? "synthetic" : "none",
    boundaryArtifacts:
      status === "covered"
        ? ["packages/test/scenarios/fixture.scenario.ts"]
        : [],
    boundarySignals: status === "covered" ? [id] : [],
    workstream: "#22898",
    status,
    reason:
      "Fixture classification has an explicit and actionable written reason.",
    ...overrides,
  };
}

function inventory(rows: RuntimeSurfaceRow[]): RuntimeSurfaceInventory {
  return {
    schema: RUNTIME_SURFACE_SCHEMA,
    generatedAt: "2026-08-20T00:00:00.000Z",
    sourceRevision: "fixture",
    packages: [],
    rows,
    summary: { total: rows.length, byKind: {}, byStatus: {} },
    gaps: {
      byOwner: {},
      byExternalDependency: {},
      byScenarioLane: {},
      byWorkstream: {},
    },
  };
}

function baseline(
  entries: Array<[string, Exclude<RuntimeSurfaceStatus, "covered">, string?]>,
): RuntimeSurfaceBaseline {
  return {
    schema: RUNTIME_SURFACE_SCHEMA,
    generatedFrom: "fixture",
    classifications: Object.fromEntries(
      entries.map(([id, status, reason]) => [
        id,
        {
          status,
          reason:
            reason ??
            "Fixture classification has an explicit and actionable written reason.",
        },
      ]),
    ),
  };
}

describe("runtime-surface production inventory", () => {
  const realBaseline = loadRuntimeSurfaceBaseline();
  const realInventory = buildRuntimeSurfaceInventory({
    baseline: realBaseline,
    generatedAt: "2026-08-20T00:00:00.000Z",
  });

  test("enforces the committed classification ratchet against production registrations", () => {
    const result = evaluateRuntimeSurfaceCoverage(realInventory, realBaseline);
    expect(result, JSON.stringify(result, null, 2)).toMatchObject({ ok: true });
  });

  test("covers every declared runtime kind with source-backed canonical rows", () => {
    expect(realInventory.rows.length).toBeGreaterThan(700);
    const kinds = new Set(realInventory.rows.map((entry) => entry.kind));
    const requiredKinds: RuntimeSurfaceKind[] = [
      "action",
      "subaction",
      "provider",
      "service",
      "evaluator",
      "event-handler",
      "route",
      "view",
      "model-handler",
      "connector-ingress",
      "connector-egress",
      "scheduled-worker",
      "queue",
      "native-bridge",
      "cloud-service",
    ];
    for (const required of requiredKinds) {
      expect(kinds.has(required), `missing ${required}`).toBe(true);
    }
    for (const surface of realInventory.rows) {
      expect(
        existsSync(path.join(RUNTIME_SURFACE_REPO_ROOT, surface.sourcePath)),
      ).toBe(true);
      expect(surface.owner.length).toBeGreaterThan(0);
      expect(surface.reason.length).toBeGreaterThan(23);
    }
  });

  test("accounts for every maintained plugin and host package, including packages with no registration", () => {
    const pluginPackages = realInventory.packages.filter((entry) =>
      entry.packageDir.startsWith("plugins/"),
    );
    const maintainedPluginCount = readdirSync(
      path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins"),
    ).filter((entry) =>
      existsSync(
        path.join(RUNTIME_SURFACE_REPO_ROOT, "plugins", entry, "package.json"),
      ),
    ).length;
    expect(pluginPackages.length).toBe(maintainedPluginCount);
    expect(
      realInventory.packages.find(
        (entry) => entry.packageName === "@elizaos/plugin-google-genai",
      ),
    ).toMatchObject({ registrationState: "registered-surfaces" });
    expect(
      realInventory.packages.find(
        (entry) => entry.packageName === "@elizaos/native-plugin-shared-types",
      ),
    ).toMatchObject({
      registrationState: "no-runtime-registration",
      registeredSurfaceIds: [],
    });
    for (const packageRecord of realInventory.packages) {
      expect(packageRecord.reason.length).toBeGreaterThan(23);
    }
  });

  test("follows spreads, factories, promoted subactions, platform exports, and host config", () => {
    const has = (predicate: (entry: RuntimeSurfaceRow) => boolean): boolean =>
      realInventory.rows.some(predicate);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-todos" &&
          entry.kind === "view" &&
          entry.surfaceName === "todos",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-google-genai" &&
          entry.kind === "model-handler" &&
          entry.surfaceName === "TEXT_SMALL_MODEL_TYPE",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-fish-audio" &&
          entry.kind === "model-handler" &&
          entry.surfaceName === "TEXT_TO_SPEECH",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-native-inference" &&
          entry.kind === "model-handler",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-browser" &&
          entry.kind === "subaction" &&
          entry.surfaceName.includes("BROWSER_"),
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.kind === "native-bridge" &&
          entry.platformRequirements.includes("native-host"),
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/cloud-api" && entry.kind === "route",
      ),
    ).toBe(true);
    expect(has((entry) => entry.kind === "cloud-service")).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/core" &&
          entry.kind === "scheduled-worker" &&
          entry.surfaceName === "BATCHER_DRAIN",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-wechat" &&
          entry.kind === "connector-ingress" &&
          entry.surfaceName === "wechat",
      ),
    ).toBe(true);
    expect(
      has(
        (entry) =>
          entry.packageName === "@elizaos/plugin-discord" &&
          entry.kind === "connector-ingress" &&
          entry.surfaceName === "discord",
      ),
    ).toBe(true);
    expect(
      realInventory.rows
        .filter((entry) =>
          [
            "scheduled-worker",
            "queue",
            "connector-ingress",
            "connector-egress",
          ].includes(entry.kind),
        )
        .every(
          (entry) =>
            !entry.surfaceName.includes("=>") &&
            !entry.surfaceName.includes("{ name:") &&
            !entry.registrationField.endsWith(".catch"),
        ),
    ).toBe(true);
  });

  test("covered means an executable artifact plus its exact boundary signal", () => {
    for (const surface of realInventory.rows.filter(
      (entry) => entry.status === "covered",
    )) {
      expect(surface.boundaryArtifacts.length).toBeGreaterThan(0);
      expect(surface.boundarySignals).toEqual([surface.surfaceName]);
      expect(
        surface.deterministicScenarioIds.length + surface.cloudE2eCells.length,
      ).toBeGreaterThan(0);
    }
  });

  test("reports gaps by owner, dependency, lane, and synthetic-world workstream", () => {
    expect(Object.keys(realInventory.gaps.byOwner).length).toBeGreaterThan(0);
    expect(
      Object.keys(realInventory.gaps.byExternalDependency).length,
    ).toBeGreaterThan(0);
    expect(
      realInventory.gaps.byScenarioLane["missing-deterministic"]?.length,
    ).toBeGreaterThan(0);
    expect(Object.keys(realInventory.gaps.byWorkstream).sort()).toEqual(
      expect.arrayContaining([
        "#22898",
        "#22899",
        "#22901",
        "#22902",
        "#22904",
      ]),
    );
  });
});

describe("runtime-surface adversarial ratchet", () => {
  test("accepts every explicit status class with a written reason", () => {
    const classifiedStatuses = RUNTIME_SURFACE_STATUSES.filter(
      (status): status is Exclude<RuntimeSurfaceStatus, "covered"> =>
        status !== "covered",
    );
    const rows = [row("covered", "covered")];
    const entries: Array<[string, Exclude<RuntimeSurfaceStatus, "covered">]> =
      [];
    for (const status of classifiedStatuses) {
      rows.push(row(status, status));
      entries.push([status, status]);
    }
    expect(
      evaluateRuntimeSurfaceCoverage(inventory(rows), baseline(entries)).ok,
    ).toBe(true);
  });

  test("rejects each status class when its reason is a placeholder", () => {
    for (const status of RUNTIME_SURFACE_STATUSES.filter(
      (value) => value !== "covered",
    )) {
      const result = evaluateRuntimeSurfaceCoverage(
        inventory([row(status, status)]),
        baseline([[status, status, "TBD"]]),
      );
      expect(result.ok, status).toBe(false);
      expect(result.invalidClassifications).toContain(status);
    }
  });

  test("rejects new, stale, silently covered, duplicate, and artifact-free rows", () => {
    const badCovered = row("covered", "covered", { boundarySignals: [] });
    const result = evaluateRuntimeSurfaceCoverage(
      inventory([
        badCovered,
        row("new", "exempt"),
        row("duplicate", "exempt"),
        row("duplicate", "exempt"),
      ]),
      baseline([
        ["covered", "exempt"],
        ["duplicate", "platform-deferred"],
        ["stale", "unsupported-product"],
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.newlyUnclassified).toContain("new");
    expect(result.staleClassifications).toContain("stale");
    expect(result.silentlyCovered).toContain("covered");
    expect(result.invalidCoverage).toContain("covered");
    expect(result.duplicateRows).toContain("duplicate");
  });

  test("assigns dependency-correct candidate dispositions", () => {
    expect(
      candidateClassification("native-bridge", ["native-host"], []).status,
    ).toBe("platform-deferred");
    expect(candidateClassification("model-handler", [], []).status).toBe(
      "provider-qualified-only",
    );
    expect(candidateClassification("provider", [], ["googleapis"]).status).toBe(
      "provider-qualified-only",
    );
    expect(candidateClassification("action", [], []).status).toBe("exempt");
  });
});
