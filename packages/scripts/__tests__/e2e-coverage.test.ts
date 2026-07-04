// Exercises tests e2e coverage.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCoverageMatrix,
  discoverRoutePlugins,
  discoverZeroTestPlugins,
  resolveCoverage,
} from "../e2e-coverage/inventory.ts";
import {
  COMMAND_COVERAGE,
  LARP_TEST_ARTIFACTS,
  PLUGIN_ROUTE_COVERAGE,
  VIEW_COVERAGE_GATES,
  ZERO_TEST_EXEMPT,
} from "../e2e-coverage/manifest.ts";

/**
 * The e2e coverage ship-gate (issue #8802). This is the umbrella enforcement:
 * every slash command, plugin route, and view surface that ships a real effect
 * must have a real recorded e2e (or a justified exemption), and the coverage
 * manifest must stay in lock-step with what is actually wired in source.
 *
 * It mirrors the existing static ship-gates (route-coverage.test.ts,
 * view-interaction-coverage.test.ts): a curated manifest diffed against a
 * discovered inventory, failing CI when something new ships uncovered.
 *
 * Issue #8802 prescribes the gate "start advisory for one cycle (like
 * coverage-gate.yml), then flip to required once the baseline is green."
 * `E2E_COVERAGE_GATE_ENFORCE=1` makes the develop-landscape-sensitive ratchets
 * (route-wiring drift, blocking gaps, zero-test documentation) hard failures;
 * by default they log a warning and pass, so a PR is never red merely because
 * the develop base it merges against churned its own plugin/test landscape
 * (e.g. a sibling PR adding/removing a route plugin or a plugin's first test).
 * The stable structural checks (larp rejection, exemption reasons, view gates,
 * the command contract) stay hard regardless of this flag.
 */
const ENFORCE = process.env.E2E_COVERAGE_GATE_ENFORCE === "1";

/** Hard-fail under ENFORCE; otherwise warn and pass (advisory ratchet). */
function expectRatchet(findings: string[], message: string): void {
  if (findings.length > 0 && !ENFORCE) {
    console.warn(
      `[e2e-coverage][advisory] ${message}\n  ${findings.join("\n  ")}`,
    );
  }
  expect(ENFORCE ? findings : [], message).toEqual([]);
}

describe("e2e coverage ship-gate", () => {
  test("the route-plugin manifest stays in lock-step with discovered route wiring", () => {
    const discovered = discoverRoutePlugins().map((info) => info.plugin);
    const discoveredSet = new Set(discovered);
    const manifestKeys = new Set(Object.keys(PLUGIN_ROUTE_COVERAGE));

    const missingFromManifest = discovered
      .filter((plugin) => !manifestKeys.has(plugin))
      .sort();
    const staleInManifest = [...manifestKeys]
      .filter((plugin) => !discoveredSet.has(plugin))
      .sort();

    expectRatchet(
      missingFromManifest,
      "route-wiring plugins with no coverage manifest entry — add a covered/exempt entry in e2e-coverage/manifest.ts:",
    );
    expectRatchet(
      staleInManifest,
      "manifest entries for plugins that no longer wire routes — remove them:",
    );
  });

  test("no command, plugin-route, or view surface ships without a real e2e", () => {
    const matrix = buildCoverageMatrix({
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    const blocking = matrix.blockingGaps.map(
      (gap) => `${gap.id} — ${gap.detail}`,
    );
    expectRatchet(
      blocking,
      "blocking e2e coverage gaps (close with a real e2e or a justified exemption):",
    );
  });

  test("every slash command in the served catalog is covered by the real contract", () => {
    const resolution = resolveCoverage(COMMAND_COVERAGE);
    expect(resolution.status, resolution.detail).toBe("covered");

    const matrix = buildCoverageMatrix({
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    // The served catalog must be non-trivial and fully covered.
    expect(matrix.summary.commands.total).toBeGreaterThanOrEqual(20);
    expect(matrix.summary.commands.covered).toBe(matrix.summary.commands.total);
  });

  test("every manifested command and route plugin resolves to real coverage (hard)", () => {
    // This is the hard ship-gate enforcement (independent of ENFORCE): every
    // surface the manifest CLAIMS to cover must actually resolve — its artifact
    // exists AND carries the anti-larp signal. Unlike the discovery ratchets,
    // this is not develop-landscape-sensitive (it only reads the committed
    // manifest's own artifacts), so it stays hard and fails when a claimed
    // command/route e2e is deleted, renamed, or downgraded to a larp test.
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

  test("the existing view ship-gates are referenced, not regressed", () => {
    const matrix = buildCoverageMatrix({
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    const viewGaps = matrix.items.filter(
      (item) => item.kind === "view" && item.status !== "covered",
    );
    expect(
      viewGaps.map((gap) => gap.id),
      "a referenced view ship-gate file is missing",
    ).toEqual([]);
    expect(matrix.summary.views.gates).toBe(VIEW_COVERAGE_GATES.length);
  });

  test("a shape-only larp test is never accepted as coverage", () => {
    // No covered entry may cite a known larp artifact.
    const allCovered = [
      COMMAND_COVERAGE,
      ...Object.values(PLUGIN_ROUTE_COVERAGE),
    ].filter((entry) => entry.status === "covered");
    for (const entry of allCovered) {
      if (entry.status !== "covered") continue;
      for (const artifact of entry.artifacts) {
        expect(
          LARP_TEST_ARTIFACTS.has(artifact),
          `${artifact} is a shape-only larp test and must not be cited as coverage`,
        ).toBe(false);
      }
    }
    // And resolveCoverage rejects a larp artifact even if it exists.
    const rejected = resolveCoverage({
      status: "covered",
      artifacts: [...LARP_TEST_ARTIFACTS][0]
        ? [[...LARP_TEST_ARTIFACTS][0]]
        : [],
      signals: [],
    });
    if ([...LARP_TEST_ARTIFACTS].length > 0) {
      expect(rejected.status).toBe("missing");
    }
  });

  test("every zero-test plugin gains a test or a documented exemption", () => {
    const zeroTest = discoverZeroTestPlugins();
    const documented = new Set(Object.keys(ZERO_TEST_EXEMPT));

    const undocumented = zeroTest
      .filter((plugin) => !documented.has(plugin))
      .sort();
    expectRatchet(
      undocumented,
      "plugins with no test file and no documented exemption — add a real test or a ZERO_TEST_EXEMPT entry:",
    );

    // A stale exemption (the plugin now has a test) must be removed.
    const zeroTestSet = new Set(zeroTest);
    const stale = [...documented]
      .filter((plugin) => !zeroTestSet.has(plugin))
      .sort();
    expectRatchet(
      stale,
      "ZERO_TEST_EXEMPT lists plugins that now have tests — remove them:",
    );

    // Reasons are stable structure — always required.
    for (const [plugin, reason] of Object.entries(ZERO_TEST_EXEMPT)) {
      expect(
        reason.length,
        `zero-test exemption for ${plugin} needs a written reason`,
      ).toBeGreaterThan(20);
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

  test("every exemption carries a written justification", () => {
    for (const [plugin, entry] of Object.entries(PLUGIN_ROUTE_COVERAGE)) {
      if (entry.status === "exempt") {
        expect(
          entry.reason.length,
          `exemption for ${plugin} needs a written reason`,
        ).toBeGreaterThan(20);
      }
    }
  });
});
