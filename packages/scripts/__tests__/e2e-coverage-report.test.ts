/**
 * Exercises the coverage inventory's discovery and resolution behavior —
 * fixture-driven for the matrix/resolution helpers, against the real repo for
 * plugin-surface discovery and the committed manifest's artifact integrity —
 * without imposing current-repository coverage counts or baselines.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCoverageMatrix,
  buildPluginCoverage,
  discoverZeroTestPlugins,
  inventoryPluginSurfaces,
  keylessScenariosByPlugin,
  resolveCoverage,
} from "../e2e-coverage/inventory.ts";
import {
  COMMAND_COVERAGE,
  LARP_TEST_ARTIFACTS,
  PLUGIN_ROUTE_COVERAGE,
} from "../e2e-coverage/manifest.ts";

describe("e2e coverage report helpers", () => {
  test("builds one diagnostic gap list without blocking policy fields", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "e2e-matrix-"));
    try {
      const matrix = buildCoverageMatrix({
        root,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(matrix.generatedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(Array.isArray(matrix.gaps)).toBe(true);
      expect(matrix.summary.gaps).toBe(matrix.gaps.length);
      expect("blockingGaps" in matrix.summary).toBe(false);
      expect("advisoryGaps" in matrix.summary).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("zero-test discovery ignores generated asset-only plugin directories", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "e2e-coverage-"));
    try {
      mkdirSync(path.join(root, "plugins", "plugin-generated", "assets"), {
        recursive: true,
      });
      writeFileSync(
        path.join(root, "plugins", "plugin-generated", "assets", "hero.png"),
        "",
      );
      mkdirSync(path.join(root, "plugins", "plugin-real", "src"), {
        recursive: true,
      });
      mkdirSync(path.join(root, "plugins", "plugin-placeholder"), {
        recursive: true,
      });
      writeFileSync(
        path.join(root, "plugins", "plugin-real", "package.json"),
        JSON.stringify({ name: "@elizaos/plugin-real" }),
      );
      writeFileSync(
        path.join(root, "plugins", "plugin-real", "src", "index.ts"),
        "export const plugin = {};\n",
      );
      writeFileSync(
        path.join(root, "plugins", "plugin-placeholder", "bun.lock"),
        "",
      );

      expect(discoverZeroTestPlugins(root)).toEqual([
        "plugin-placeholder",
        "plugin-real",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves covered, missing-signal, and exempt entries from fixtures", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "e2e-resolution-"));
    try {
      mkdirSync(path.join(root, "tests"), { recursive: true });
      writeFileSync(
        path.join(root, "tests", "route.test.ts"),
        'test("real route", () => routeHandler());\n',
      );

      expect(
        resolveCoverage(
          {
            status: "covered",
            artifacts: ["tests/route.test.ts"],
            signals: ["routeHandler"],
          },
          root,
        ).status,
      ).toBe("covered");
      expect(
        resolveCoverage(
          {
            status: "covered",
            artifacts: ["tests/route.test.ts"],
            signals: ["missingSignal"],
          },
          root,
        ),
      ).toMatchObject({
        status: "missing",
        missingSignals: ["missingSignal"],
      });
      expect(
        resolveCoverage(
          {
            status: "exempt",
            reason: "This route delegates to a separately verified upstream.",
          },
          root,
        ).status,
      ).toBe("exempt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects known larp artifacts even when the file exists", () => {
    const artifact = [...LARP_TEST_ARTIFACTS][0];
    expect(artifact).toBeDefined();
    if (!artifact) return;

    const root = mkdtempSync(path.join(os.tmpdir(), "e2e-larp-"));
    try {
      const file = path.join(root, artifact);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "shapeOnlyAssertion();\n");

      expect(
        resolveCoverage(
          {
            status: "covered",
            artifacts: [artifact],
            signals: ["shapeOnlyAssertion"],
          },
          root,
        ),
      ).toMatchObject({
        status: "missing",
        detail: expect.stringContaining("larp artifact"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("e2e-coverage inventory", () => {
  test("discovers plugin surfaces from source", () => {
    const surfaces = inventoryPluginSurfaces();
    expect(surfaces.length).toBeGreaterThan(0);
    // Every surface entry carries a package name and a plugin directory.
    for (const surface of surfaces) {
      expect(surface.dir).toMatch(/^plugin-/);
      expect(surface.packageName.length).toBeGreaterThan(0);
    }
  });

  test("detects action surface for an action-bearing plugin", () => {
    const surfaces = inventoryPluginSurfaces();
    const todos = surfaces.find((s) => s.dir === "plugin-todos");
    expect(todos).toBeDefined();
    expect(todos?.hasActions).toBe(true);
  });

  test("detects connector surface for a connector plugin", () => {
    const surfaces = inventoryPluginSurfaces();
    const telegram = surfaces.find((s) => s.dir === "plugin-telegram");
    expect(telegram).toBeDefined();
    expect(telegram?.hasConnector).toBe(true);
  });

  test("maps keyless scenarios to the plugins they require", () => {
    const byPlugin = keylessScenariosByPlugin();
    // The convo self-tests are lane:"pr-deterministic" and require their
    // in-memory fixture plugins; the deterministic corpus requires core plugins.
    const todoScenarios = byPlugin.get("@elizaos/plugin-agent-skills") ?? [];
    expect(todoScenarios.length).toBeGreaterThan(0);
  });

  test("a covered plugin is reported as having keyless e2e", () => {
    const coverage = buildPluginCoverage();
    const todos = coverage.find((c) => c.dir === "plugin-todos");
    expect(todos?.hasSurface).toBe(true);
    expect(todos?.hasKeylessE2e).toBe(true);
    expect(todos?.keylessScenarioIds.length).toBeGreaterThan(0);
  });
});

describe("e2e-coverage manifest artifact integrity", () => {
  test("every manifested command and route plugin resolves to real coverage", () => {
    // Every surface the committed manifest CLAIMS to cover must actually
    // resolve — its artifact exists on disk AND carries the anti-larp signal —
    // so a claimed command/route e2e cannot be deleted, renamed, or downgraded
    // to a shape-only test without failing here.
    const failures: string[] = [];
    const command = resolveCoverage(COMMAND_COVERAGE);
    if (command.status !== "covered") {
      failures.push(`commands — ${command.detail}`);
    }
    for (const [plugin, entry] of Object.entries(PLUGIN_ROUTE_COVERAGE)) {
      const resolution = resolveCoverage(entry);
      if (resolution.status === "missing") {
        failures.push(`plugin-route:${plugin} — ${resolution.detail}`);
      }
    }
    expect(
      failures,
      `manifested coverage is broken (a claimed artifact is missing or fails its anti-larp signal):\n  ${failures.join("\n  ")}`,
    ).toEqual([]);
  });

  test("no covered manifest entry cites a shape-only larp artifact", () => {
    const offenders: string[] = [];
    for (const entry of [
      COMMAND_COVERAGE,
      ...Object.values(PLUGIN_ROUTE_COVERAGE),
    ]) {
      if (entry.status !== "covered") continue;
      for (const artifact of entry.artifacts) {
        if (LARP_TEST_ARTIFACTS.has(artifact)) offenders.push(artifact);
      }
    }
    expect(
      offenders,
      `shape-only larp tests must not be cited as coverage: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
