/** Tests the loader's `--lane` filtering (loader.ts) by writing scenario files with declared lanes to a temp dir and asserting `listScenarioMetadata` returns only the matching lane. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listScenarioMetadata, loadAllScenarios } from "../loader";

let tempDirs: string[] = [];

function makeScenarioDir(
  files: Record<string, { id: string; lane?: string; status?: string }>,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scenario-lane-filter-"));
  tempDirs.push(dir);
  for (const [fileName, { id, lane, status }] of Object.entries(files)) {
    writeFileSync(
      path.join(dir, fileName),
      [
        "export default {",
        `  id: "${id}",`,
        `  title: "${id}",`,
        '  domain: "loader-test",',
        ...(lane ? [`  lane: "${lane}",`] : []),
        ...(status ? [`  status: "${status}",`] : []),
        "  turns: [],",
        "};",
        "",
      ].join("\n"),
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("listScenarioMetadata lane filtering", () => {
  it("includes scenarios without a declared lane when filtering by the default lane", async () => {
    // A scenario that declares no lane IS a live-only scenario
    // (DEFAULT_SCENARIO_LANE). `list --lane live-only` must therefore agree
    // with `run --lane live-only`, which resolves the lane via scenarioLane().
    const dir = makeScenarioDir({
      "undeclared.scenario.ts": { id: "lane-undeclared" },
      "deterministic.scenario.ts": {
        id: "lane-deterministic",
        lane: "pr-deterministic",
      },
    });

    const liveOnly = await listScenarioMetadata(
      dir,
      undefined,
      undefined,
      false,
      "live-only",
    );
    expect(liveOnly.map((scenario) => scenario.id)).toEqual([
      "lane-undeclared",
    ]);
  });

  it("still filters declared lanes exactly", async () => {
    const dir = makeScenarioDir({
      "undeclared.scenario.ts": { id: "lane-undeclared" },
      "deterministic.scenario.ts": {
        id: "lane-deterministic",
        lane: "pr-deterministic",
      },
    });

    const deterministic = await listScenarioMetadata(
      dir,
      undefined,
      undefined,
      false,
      "pr-deterministic",
    );
    expect(deterministic.map((scenario) => scenario.id)).toEqual([
      "lane-deterministic",
    ]);

    const unfiltered = await listScenarioMetadata(dir);
    expect(unfiltered.map((scenario) => scenario.id).sort()).toEqual([
      "lane-deterministic",
      "lane-undeclared",
    ]);
  });

  it("excludes pending scenarios from list and run inventories unless explicitly included", async () => {
    const previous = process.env.SCENARIO_INCLUDE_PENDING;
    const dir = makeScenarioDir({
      "active.scenario.ts": {
        id: "pending-active",
        lane: "live-only",
      },
      "pending.scenario.ts": {
        id: "pending-hidden",
        lane: "live-only",
        status: "pending",
      },
    });

    try {
      delete process.env.SCENARIO_INCLUDE_PENDING;

      await expect(listScenarioMetadata(dir)).resolves.toMatchObject([
        { id: "pending-active" },
      ]);
      await expect(loadAllScenarios(dir)).resolves.toHaveLength(1);

      process.env.SCENARIO_INCLUDE_PENDING = "1";

      await expect(
        listScenarioMetadata(dir).then((scenarios) =>
          scenarios.map((scenario) => scenario.id).sort(),
        ),
      ).resolves.toEqual(["pending-active", "pending-hidden"]);
      await expect(
        loadAllScenarios(dir).then((scenarios) =>
          scenarios.map(({ scenario }) => scenario.id).sort(),
        ),
      ).resolves.toEqual(["pending-active", "pending-hidden"]);
    } finally {
      if (previous === undefined) {
        delete process.env.SCENARIO_INCLUDE_PENDING;
      } else {
        process.env.SCENARIO_INCLUDE_PENDING = previous;
      }
    }
  });
});
