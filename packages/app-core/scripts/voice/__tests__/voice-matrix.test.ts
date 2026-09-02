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

function executable(file: string, source: string) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

describe("voice matrix CLI", () => {
  test("fails closed when a platform/id filter selects no cells", () => {
    const filterCanary = "FILTER_CANARY_room-private-9911";
    const { report, result } = runVoiceMatrix(
      ["--platform", filterCanary, "--require-green"],
      { ELIZA_VOICE_MATRIX_SESSION_ID: "voice-matrix-session-123" },
    );

    expect(result.status).toBe(1);
    expect(report.schema).toBe("eliza_voice_live_matrix_v2");
    expect(report.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(report.sessionId).toBe("voice-matrix-session-123");
    expect(report.selection).toEqual({
      filterCount: 1,
      matched: 0,
      errorCode: "NO_MATCH",
    });
    expect(report.cells).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain(filterCanary);
  });

  test("accepts the iOS voice roundtrip cell id filter", () => {
    const { report, result } = runVoiceMatrix([
      "--platform",
      "ios.sim-or-device.voice-roundtrip",
    ]);

    expect(result.status).toBe(0);
    expect(report.selection).toEqual({
      filterCount: 1,
      matched: 1,
      errorCode: null,
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
      code: "WEB_LIVE_CREDENTIAL_MISSING",
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

  test("projects command diagnostics without host identity or raw output", () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-matrix-bin-"));
    const stdoutCanary = "MODEL_RESPONSE_CANARY_room-7788";
    const stderrCanary = "STDERR_CANARY_trajectory-9911";
    executable(
      path.join(binDir, "bun"),
      `#!/bin/sh\nprintf '%s\\n' '${stdoutCanary}'\nprintf '%s\\n' '${stderrCanary}' >&2\nkill -TERM $$\n`,
    );

    const runnerOsCanary = "RUNNER_OS_CANARY_private-host";
    const runnerArchCanary = "RUNNER_ARCH_CANARY_private-host";

    const { outDir, report, result } = runVoiceMatrix(
      ["--run", "--platform", "web.failure-paths"],
      {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNNER_OS: runnerOsCanary,
        RUNNER_ARCH: runnerArchCanary,
      },
    );
    const serialized = [
      JSON.stringify(report),
      fs.readFileSync(path.join(outDir, "voice-matrix.md"), "utf8"),
      fs.readFileSync(path.join(outDir, "index.html"), "utf8"),
      result.stdout,
      result.stderr,
    ].join("\n");

    expect(result.status).toBe(1);
    expect(report.host).not.toHaveProperty("hostname");
    expect(report.cells[0].execution).toEqual({
      exitCode: null,
      signalCode: "TERMINATED",
      code: "COMMAND_SIGNALLED",
    });
    expect(report.cells[0].probe).toEqual({
      available: true,
      code: "WEB_FAKE_DEVICE_AVAILABLE",
    });
    expect(serialized).not.toContain(os.hostname());
    expect(serialized).not.toContain(stdoutCanary);
    expect(serialized).not.toContain(stderrCanary);
    expect(serialized).not.toContain(runnerOsCanary);
    expect(serialized).not.toContain(runnerArchCanary);
    expect(serialized).not.toContain("stdoutTail");
    expect(serialized).not.toContain("stderrTail");
  });
});
