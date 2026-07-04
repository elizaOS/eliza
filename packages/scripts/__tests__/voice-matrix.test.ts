// Exercises tests voice matrix.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../voice-matrix.mjs", import.meta.url),
);
const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");

function runVoiceMatrix(args: string[]) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-matrix-"));
  const result = spawnSync("node", [scriptPath, ...args, "--out", outDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const reportPath = path.join(outDir, "voice-matrix.json");
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
    : null;
  return { outDir, report, result };
}

describe("voice matrix CLI", () => {
  test("fails closed when a platform/id filter selects no cells", () => {
    const { report, result } = runVoiceMatrix([
      "--platform",
      "ios.sim.voice-roundtrip",
      "--require-green",
    ]);

    expect(result.status).toBe(1);
    expect(report.selection).toEqual({
      platformFilters: ["ios.sim.voice-roundtrip"],
      matched: 0,
      error: "no voice matrix cells matched --platform=ios.sim.voice-roundtrip",
    });
    expect(report.cells).toHaveLength(0);
  });

  test("accepts the iOS voice roundtrip cell id filter", () => {
    const { report, result } = runVoiceMatrix([
      "--platform",
      "ios.sim-or-device.voice-roundtrip",
    ]);

    expect(result.status).toBe(0);
    expect(report.selection).toEqual({
      platformFilters: ["ios.sim-or-device.voice-roundtrip"],
      matched: 1,
      error: null,
    });
    expect(report.cells).toHaveLength(1);
    expect(report.cells[0].id).toBe("ios.sim-or-device.voice-roundtrip");
  });
});
