import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listScenarioMetadata } from "../loader";

let tempDirs: string[] = [];

function makeScenarioDir(
  files: Record<string, { id: string; lane?: string }>,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scenario-lane-filter-"));
  tempDirs.push(dir);
  for (const [fileName, { id, lane }] of Object.entries(files)) {
    writeFileSync(
      path.join(dir, fileName),
      [
        "export default {",
        `  id: "${id}",`,
        `  title: "${id}",`,
        '  domain: "loader-test",',
        ...(lane ? [`  lane: "${lane}",`] : []),
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
});
