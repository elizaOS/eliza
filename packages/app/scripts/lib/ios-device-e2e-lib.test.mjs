/**
 * Unit tests for the pure step-sequencing, command-argument construction, and
 * run-summary assembly behind the one-command physical-iPhone e2e lane
 * (issue #14337). Asserts the exact argv each chained script receives and the
 * summary schema, with the device calls left at the process boundary (never
 * spawned here). Runs in the packages/app vitest suite.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDeviceDeployCommand,
  buildDeviceLogsCommand,
  buildDeviceSmokeCommand,
  buildRunSummary,
  classifyStepStatus,
  formatRunId,
  IOS_DEVICE_E2E_STEP_IDS,
  planIosDeviceE2eSteps,
} from "./ios-device-e2e-lib.mjs";

const scriptsDir = "/repo/packages/app/scripts";
const deviceId = "UDID-1";

describe("planIosDeviceE2eSteps", () => {
  it("includes deploy + smoke + logs in order; no separate capture boot", () => {
    const ids = planIosDeviceE2eSteps().map((s) => s.id);
    expect(ids).toEqual(["deploy", "smoke", "logs"]);
    expect(ids).toEqual([...IOS_DEVICE_E2E_STEP_IDS]);
  });
  it("--skip-logs drops only the logs step, keeping the deploy + smoke pair", () => {
    expect(planIosDeviceE2eSteps({ skipLogs: true }).map((s) => s.id)).toEqual([
      "deploy",
      "smoke",
    ]);
  });
});

describe("buildDeviceDeployCommand", () => {
  it("passes --skip-appexes by default plus the device", () => {
    const { cmd, args } = buildDeviceDeployCommand({ scriptsDir, deviceId });
    expect(cmd).toBe("node");
    expect(args).toEqual([
      path.join(scriptsDir, "ios-device-deploy.mjs"),
      "--device",
      deviceId,
      "--skip-appexes",
    ]);
  });
  it("omits --skip-appexes when opted out and threads optional flags", () => {
    const { args } = buildDeviceDeployCommand({
      scriptsDir,
      deviceId,
      skipAppexes: false,
      skipBuild: true,
      noLaunch: true,
      bundleId: "ai.elizaos.app",
    });
    expect(args).not.toContain("--skip-appexes");
    expect(args).toContain("--skip-build");
    expect(args).toContain("--no-launch");
    expect(args).toContain("--bundle-id");
    expect(args).toContain("ai.elizaos.app");
  });
  it("throws without a deviceId", () => {
    expect(() => buildDeviceDeployCommand({ scriptsDir })).toThrow(
      /deviceId is required/,
    );
  });
});

describe("buildDeviceSmokeCommand", () => {
  it("forces --skip-build and targets the smoke output dir", () => {
    const { args } = buildDeviceSmokeCommand({
      scriptsDir,
      deviceId,
      outputDir: "/bundle/smoke",
    });
    expect(args).toEqual([
      path.join(scriptsDir, "ios-device-capture.mjs"),
      "--platform",
      "device",
      "--device",
      deviceId,
      "--skip-build",
      "--output",
      "/bundle/smoke",
    ]);
  });
  it("threads --require-chat when asked", () => {
    const { args } = buildDeviceSmokeCommand({
      scriptsDir,
      deviceId,
      outputDir: "/bundle/smoke",
      requireChat: true,
    });
    expect(args).toContain("--require-chat");
  });
  it("throws without an output dir", () => {
    expect(() => buildDeviceSmokeCommand({ scriptsDir, deviceId })).toThrow(
      /outputDir is required/,
    );
  });
});

describe("buildDeviceLogsCommand", () => {
  it("uses --no-console --pull-boot-trace (the #11515 engine path)", () => {
    const { args } = buildDeviceLogsCommand({
      scriptsDir,
      deviceId,
      outputFile: "/bundle/logs/boot-trace-run",
    });
    expect(args).toEqual([
      path.join(scriptsDir, "ios-device-logs.mjs"),
      "--device",
      deviceId,
      "--no-console",
      "--pull-boot-trace",
      "--output",
      "/bundle/logs/boot-trace-run",
    ]);
  });
  it("throws without an output file", () => {
    expect(() => buildDeviceLogsCommand({ scriptsDir, deviceId })).toThrow(
      /outputFile is required/,
    );
  });
});

describe("classifyStepStatus", () => {
  it("only exit 0 passes", () => {
    expect(classifyStepStatus(0)).toEqual({ status: "passed", ok: true });
    expect(classifyStepStatus(1)).toEqual({ status: "failed", ok: false });
    // A null status (child never launched) is a failure, never a pass.
    expect(classifyStepStatus(null)).toEqual({ status: "failed", ok: false });
  });
});

describe("buildRunSummary", () => {
  const base = {
    runId: "20260101-000000",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:05:00Z",
    bundleDir: "/bundle/ios-20260101-000000",
    device: { udid: "UDID-1", identifier: "ID-1", name: "iPhone 16" },
    build: { buildId: "build-XYZ", commit: "deadbeef" },
    skippedAppexes: true,
  };

  it("marks passed only when every step passed", () => {
    const summary = buildRunSummary({
      ...base,
      steps: [
        {
          id: "deploy",
          label: "d",
          status: "passed",
          durationMs: 10,
          artifacts: [],
        },
        {
          id: "smoke",
          label: "s",
          status: "passed",
          durationMs: 20,
          artifacts: ["/a"],
        },
      ],
    });
    expect(summary.overallStatus).toBe("passed");
    expect(summary.schema).toBe("elizaos.device-e2e.summary/v1");
    expect(summary.lane).toBe("ios-device-e2e");
    expect(summary.device.udid).toBe("UDID-1");
    expect(summary.build.buildId).toBe("build-XYZ");
    expect(summary.skippedAppexes).toBe(true);
    expect(summary.steps).toHaveLength(2);
  });
  it("marks failed when any step failed", () => {
    const summary = buildRunSummary({
      ...base,
      steps: [
        {
          id: "deploy",
          label: "d",
          status: "passed",
          durationMs: 10,
          artifacts: [],
        },
        {
          id: "smoke",
          label: "s",
          status: "failed",
          durationMs: 20,
          artifacts: [],
        },
      ],
    });
    expect(summary.overallStatus).toBe("failed");
  });
  it("throws without a runId", () => {
    expect(() => buildRunSummary({ ...base, runId: "", steps: [] })).toThrow(
      /runId is required/,
    );
  });
});

describe("formatRunId", () => {
  it("produces a sortable YYYYMMDD-HHMMSS from a Date", () => {
    expect(formatRunId(new Date("2026-07-05T13:04:09.000Z"))).toBe(
      "20260705-130409",
    );
  });
});
