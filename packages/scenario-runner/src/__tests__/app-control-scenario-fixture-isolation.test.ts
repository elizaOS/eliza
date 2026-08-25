/**
 * Pins fixture-tree isolation for the two app-control scenarios.
 *
 * Both scenarios `rm -rf` their fixture root in the seed step and again in
 * cleanup. When that root was a shared constant (`/tmp/eliza-app-control-*`),
 * two runner processes on one host owned the same path: whichever seeded second
 * deleted the first run's seeded apps and plugin sources mid-run, and the
 * losing run failed with `Not a directory: <root>/apps` from the
 * load_from_directory discovery and `Could not locate the source directory ...`
 * from the view/app edit paths. Keying the root on the process id keeps
 * concurrent runs isolated, so this test asserts the root is process-scoped
 * rather than a constant any other process could also claim.
 */

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";

import actionsScenario from "../../test/scenarios/deterministic-app-control-actions.scenario.ts";
import nlRoutingScenario from "../../test/scenarios/deterministic-app-control-nl-routing.scenario.ts";

/**
 * The apps directory each scenario actually drives its load_from_directory
 * turn against — read from the authored turn rather than re-derived here, so
 * the assertions cover the value the runner really uses.
 */
function appLoadDirectoryOf(scenario: ScenarioDefinition): string {
  for (const turn of scenario.turns ?? []) {
    const options = (turn as { options?: unknown }).options;
    if (options && typeof options === "object" && !Array.isArray(options)) {
      const record = options as Record<string, unknown>;
      if (
        record.action === "load_from_directory" &&
        typeof record.directory === "string"
      ) {
        return record.directory;
      }
    }
    const text = (turn as { text?: unknown }).text;
    if (typeof text === "string") {
      const match = /^Load apps from (.+) directory$/.exec(text);
      if (match?.[1]) return match[1];
    }
  }
  throw new Error(
    `scenario ${scenario.id} has no load_from_directory turn to read a fixture root from`,
  );
}

const scenarios: Array<[string, ScenarioDefinition]> = [
  ["deterministic-app-control-actions", actionsScenario as ScenarioDefinition],
  [
    "deterministic-app-control-nl-routing",
    nlRoutingScenario as ScenarioDefinition,
  ],
];

describe("app-control scenario fixture isolation", () => {
  it.each(scenarios)(
    "%s owns a process-scoped fixture root under the OS temp dir",
    (_id, scenario) => {
      const appsDirectory = appLoadDirectoryOf(scenario);
      const fixtureRoot = path.dirname(appsDirectory);

      // Under the OS temp dir, not a hand-written absolute path.
      expect(
        fixtureRoot.startsWith(`${realpathSync(os.tmpdir())}${path.sep}`),
      ).toBe(true);

      // Process-scoped: a second concurrent runner resolves a different root,
      // so its seed/cleanup `rm -rf` cannot reach this run's fixtures.
      const rootName = path.basename(fixtureRoot);
      expect(rootName).toContain(String(process.pid));
      const otherProcessRoot = rootName.replace(
        String(process.pid),
        String(process.pid + 1),
      );
      expect(otherProcessRoot).not.toBe(rootName);
    },
  );

  it("gives the two app-control scenarios distinct fixture roots", () => {
    const [actionsRoot, nlRoutingRoot] = scenarios.map(([, scenario]) =>
      path.dirname(appLoadDirectoryOf(scenario)),
    );
    expect(actionsRoot).not.toBe(nlRoutingRoot);
  });
});
