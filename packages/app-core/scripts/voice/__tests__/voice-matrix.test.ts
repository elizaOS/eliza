/** Exercises voice-matrix CLI selection and gating with deterministic subprocess fixtures. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../voice-matrix.mjs", import.meta.url),
);
const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..", "..", "..");

function runVoiceMatrix(args: string[], env: NodeJS.ProcessEnv = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-matrix-"));
  const result = spawnSync("node", [scriptPath, ...args, "--out", outDir], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
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

  test("isolates the live Railway browser test and requires both credentials", () => {
    const missingCloud = runVoiceMatrix(
      ["--platform", "web.live.railway-roundtrip"],
      {
        ELIZA_VOICE_LIVE_RAILWAY: "1",
        CEREBRAS_API_KEY: "test-model-key",
        ELIZAOS_CLOUD_API_KEY: "",
      },
    );

    expect(missingCloud.result.status).toBe(0);
    expect(missingCloud.report.cells[0].probe).toEqual({
      available: false,
      reason:
        "ELIZAOS_CLOUD_API_KEY is required for the live Railway browser round-trip",
    });

    const provisioned = runVoiceMatrix(
      ["--platform", "web.live.railway-roundtrip"],
      {
        ELIZA_VOICE_LIVE_RAILWAY: "1",
        CEREBRAS_API_KEY: "test-model-key",
        ELIZAOS_CLOUD_API_KEY: "test-cloud-key",
      },
    );

    expect(provisioned.report.cells[0].command).toEqual([
      "bun",
      "run",
      "--cwd",
      "packages/app",
      "test:e2e",
      "test/ui-smoke/voice-realaudio.spec.ts",
      "--grep",
      "live cloud voice round-trip",
    ]);
    expect(provisioned.report.cells[0].env).toMatchObject({
      ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE: "1",
      ELIZA_UI_SMOKE_SKIP_BUILD: "1",
    });
    expect(provisioned.report.cells[0].env).not.toHaveProperty(
      "ELIZA_UI_SMOKE_CLOUD_LIVE",
    );
    expect(provisioned.report.cells[0].probe.available).toBe(true);
  });

  test("registers the three visible browser failure paths as a recordable cell", () => {
    const { report, result } = runVoiceMatrix([
      "--platform",
      "web.failure-paths",
    ]);

    expect(result.status).toBe(0);
    expect(report.selection.matched).toBe(1);
    expect(report.cells[0]).toMatchObject({
      id: "web.failure-paths",
      class: "voice-three-state-failures",
      probe: { available: true },
    });
    expect(report.cells[0].command).toEqual(
      expect.arrayContaining(["--grep", "voice failure paths"]),
    );
  });
});
