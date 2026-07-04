// Exercises e2e coverage check e2e coverage.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import {
  type CoverageGateResult,
  evaluateCoverage,
  loadBaseline,
} from "./check-e2e-coverage.ts";
import {
  buildPluginCoverage,
  inventoryPluginSurfaces,
  keylessScenariosByPlugin,
} from "./inventory.ts";

describe("e2e-coverage inventory", () => {
  test("discovers plugin surfaces from source", () => {
    const surfaces = inventoryPluginSurfaces();
    // The repo ships many plugins; the inventory must see a meaningful set.
    expect(surfaces.length).toBeGreaterThan(20);
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

describe("e2e-coverage gate", () => {
  test("the real baseline passes the gate", () => {
    const coverage = buildPluginCoverage();
    const baseline = loadBaseline();
    const result = evaluateCoverage(coverage, baseline);
    const message = JSON.stringify(
      {
        newlyUncovered: result.newlyUncovered,
        staleCovered: result.staleCovered,
        staleMissing: result.staleMissing,
      },
      null,
      2,
    );
    expect(result.ok, message).toBe(true);
  });

  test("every baselined plugin still exposes a surface and lacks coverage", () => {
    const coverage = buildPluginCoverage();
    const baseline = loadBaseline();
    const byDir = new Map(coverage.map((c) => [c.dir, c]));
    for (const dir of baseline.knownUncovered) {
      const entry = byDir.get(dir);
      expect(
        entry,
        `baseline entry ${dir} not found in inventory`,
      ).toBeDefined();
      expect(entry?.hasSurface, `baseline entry ${dir} has no surface`).toBe(
        true,
      );
      expect(
        entry?.hasKeylessE2e,
        `baseline entry ${dir} is now covered — remove it from the baseline`,
      ).toBe(false);
    }
  });

  test("flags a surface plugin that is neither covered nor baselined", () => {
    const coverage = buildPluginCoverage();
    // Drop the first baseline entry to simulate a newly-uncovered plugin.
    const baseline = loadBaseline();
    const [dropped, ...rest] = baseline.knownUncovered;
    expect(dropped).toBeDefined();
    const result: CoverageGateResult = evaluateCoverage(coverage, {
      knownUncovered: rest,
    });
    expect(result.ok).toBe(false);
    expect(result.newlyUncovered).toContain(dropped);
  });

  test("flags a baseline entry that no longer exists (ratchet must shrink)", () => {
    const coverage = buildPluginCoverage();
    const baseline = loadBaseline();
    const result = evaluateCoverage(coverage, {
      knownUncovered: [...baseline.knownUncovered, "plugin-does-not-exist"],
    });
    expect(result.ok).toBe(false);
    expect(result.staleMissing).toContain("plugin-does-not-exist");
  });

  test("flags a baseline entry that is now covered (ratchet must shrink)", () => {
    const coverage = buildPluginCoverage();
    const covered = coverage.find((c) => c.hasSurface && c.hasKeylessE2e);
    expect(covered).toBeDefined();
    const baseline = loadBaseline();
    const result = evaluateCoverage(coverage, {
      // Pretend a covered plugin is still baselined as uncovered.
      knownUncovered: [...baseline.knownUncovered, covered?.dir ?? ""],
    });
    expect(result.ok).toBe(false);
    expect(result.staleCovered).toContain(covered?.dir);
  });
});
