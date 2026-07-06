/**
 * Tests for certify-parallel.mjs (#14549) degradation behavior, run against
 * the real process: a docker-less PATH must print the serial native fallback
 * and exit with the distinct EXIT_NO_DOCKER code (callers can tell "degraded"
 * from "failed"), and --dry-run with docker present must derive the full lane
 * set from the live plan without starting containers. The containerized happy
 * path is the owner-gated on-Linux acceptance run (issue #14549).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTimingsReport } from "./certify-parallel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const orchestratorPath = path.join(here, "certify-parallel.mjs");

function runOrchestrator(args, env) {
  return spawnSync(process.execPath, [orchestratorPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("certify-parallel degradation", () => {
  test("no docker on PATH → serial fallback instructions + EXIT_NO_DOCKER(4)", () => {
    // A bare PATH with only the node binary's dir: `docker` cannot resolve.
    const nodeDir = path.dirname(process.execPath);
    const result = runOrchestrator([], { ...process.env, PATH: nodeDir });
    expect(result.status).toBe(4);
    expect(result.stdout).toContain("docker compose is not available");
    expect(result.stdout).toContain("bun run test");
    expect(result.stdout).toContain("scripts/gpu-vision/serve.mjs");
    expect(result.stdout).toContain("EXIT_NO_DOCKER");
  });

  test("rejects an unknown tier before touching docker", () => {
    const result = runOrchestrator(["--tier", "warp"], process.env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--tier must be cpu|full");
  });
});

describe("certify-parallel dry run (requires docker client)", () => {
  // Timed probe: a wedged Docker Desktop must skip these legs, not hang them.
  const probe = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const dockerUsable = !probe.error && probe.status === 0;

  test.if(dockerUsable)(
    "derives the lane set from the live plan and stops before containers",
    () => {
      const result = runOrchestrator(["--dry-run"], process.env);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/tier=cpu lanes=10/);
      expect(result.stdout).toContain("unit-1of4");
      expect(result.stdout).toContain("cloud");
      expect(result.stdout).toContain("dry run");
    },
    120_000,
  );

  test.if(dockerUsable)(
    "non-default params bypass the committed-file drift gate",
    () => {
      const result = runOrchestrator(
        [
          "--dry-run",
          "--cores",
          "9",
          "--unit-shards",
          "3",
          "--e2e-shards",
          "1",
        ],
        process.env,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/lanes=8/);
    },
    120_000,
  );

  test.if(!dockerUsable)(
    "docker client unavailable — dry-run legs skipped (stated)",
    () => {
      // Not silent: this test names the skipped coverage. The drift gate and
      // no-docker degradation above still ran.
      expect(dockerUsable).toBe(false);
    },
  );
});

describe("buildTimingsReport", () => {
  test("timings is a flat Record<phase, ms> (BundleMeta.timings-compatible)", () => {
    const report = buildTimingsReport({
      tier: "cpu",
      params: { cores: 16, unitShards: 4, e2eShards: 2, gpuParallel: 4 },
      startedAt: new Date("2026-07-06T10:00:00Z"),
      finishedAt: new Date("2026-07-06T10:20:00Z"),
      lanes: {
        "unit-1of4": {
          service: "lane-unit-1of4",
          exitCode: 0,
          startedAt: "2026-07-06T10:00:05Z",
          finishedAt: "2026-07-06T10:15:00Z",
          durationMs: 895_000,
        },
      },
      timedOut: false,
    });
    expect(report.schema).toBe(1);
    expect(report.wallClockMs).toBe(20 * 60 * 1000);
    expect(report.timings).toEqual({
      wall: 20 * 60 * 1000,
      "lane:unit-1of4": 895_000,
    });
    for (const value of Object.values(report.timings)) {
      expect(typeof value).toBe("number");
    }
    // cpu tier records the gpu profile as an honest skip, never as absent.
    expect(report.skipped).toEqual([
      {
        lane: "gpu",
        reason: "tier=cpu — gpu profile not started; queue jobs remain pending",
      },
    ]);
    expect(
      buildTimingsReport({
        tier: "full",
        params: {},
        startedAt: new Date(0),
        finishedAt: new Date(1),
        lanes: {},
        timedOut: true,
      }),
    ).toMatchObject({ skipped: [], timedOut: true, wallClockMs: 1 });
  });
});
