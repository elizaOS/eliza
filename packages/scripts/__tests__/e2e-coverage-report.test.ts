/**
 * Exercises the coverage inventory's fixture-driven discovery and resolution
 * behavior without imposing repository coverage counts or baselines.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildKeylessCoverageReport } from "../e2e-coverage/check-e2e-coverage.ts";
import {
  buildCoverageMatrix,
  discoverZeroTestPlugins,
  resolveCoverage,
} from "../e2e-coverage/inventory.ts";
import { LARP_TEST_ARTIFACTS } from "../e2e-coverage/manifest.ts";

describe("e2e coverage report helpers", () => {
  test("partitions keyless coverage without a baseline", () => {
    const report = buildKeylessCoverageReport([
      {
        dir: "plugin-covered",
        packageName: "@elizaos/plugin-covered",
        hasActions: true,
        hasConnector: false,
        hasSurface: true,
        keylessScenarioIds: ["covered"],
        hasKeylessE2e: true,
      },
      {
        dir: "plugin-uncovered",
        packageName: "@elizaos/plugin-uncovered",
        hasActions: false,
        hasConnector: true,
        hasSurface: true,
        keylessScenarioIds: [],
        hasKeylessE2e: false,
      },
      {
        dir: "plugin-no-surface",
        packageName: "@elizaos/plugin-no-surface",
        hasActions: false,
        hasConnector: false,
        hasSurface: false,
        keylessScenarioIds: [],
        hasKeylessE2e: false,
      },
    ]);

    expect(report).toEqual({
      covered: ["plugin-covered"],
      uncovered: ["plugin-uncovered"],
    });
  });

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
