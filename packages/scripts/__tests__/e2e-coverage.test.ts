import { describe, expect, test } from "bun:test";

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
 */
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

    expect(
      missingFromManifest,
      `route-wiring plugins with no coverage manifest entry — add a covered/exempt entry in e2e-coverage/manifest.ts:\n  ${missingFromManifest.join("\n  ")}`,
    ).toEqual([]);
    expect(
      staleInManifest,
      `manifest entries for plugins that no longer wire routes — remove them:\n  ${staleInManifest.join("\n  ")}`,
    ).toEqual([]);
  });

  test("no command, plugin-route, or view surface ships without a real e2e", () => {
    const matrix = buildCoverageMatrix({
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    const blocking = matrix.blockingGaps.map(
      (gap) => `${gap.id} — ${gap.detail}`,
    );
    expect(
      blocking,
      `blocking e2e coverage gaps (close with a real e2e or a justified exemption):\n  ${blocking.join("\n  ")}`,
    ).toEqual([]);
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
    expect(
      undocumented,
      `plugins with no test file and no documented exemption — add a real test or a ZERO_TEST_EXEMPT entry:\n  ${undocumented.join("\n  ")}`,
    ).toEqual([]);

    // A stale exemption (the plugin now has a test) must be removed.
    const zeroTestSet = new Set(zeroTest);
    const stale = [...documented]
      .filter((plugin) => !zeroTestSet.has(plugin))
      .sort();
    expect(
      stale,
      `ZERO_TEST_EXEMPT lists plugins that now have tests — remove them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);

    for (const [plugin, reason] of Object.entries(ZERO_TEST_EXEMPT)) {
      expect(
        reason.length,
        `zero-test exemption for ${plugin} needs a written reason`,
      ).toBeGreaterThan(20);
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
