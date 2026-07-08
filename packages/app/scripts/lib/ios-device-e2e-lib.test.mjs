/**
 * Unit tests for the pure step-planning and command-argument construction behind
 * the one-command physical-iPhone e2e lane (issue #14337). Asserts the exact argv
 * each chained script receives, with the device calls left at the process
 * boundary (never spawned here). Run assembly + summary live in the shared
 * `device-e2e-bundle.mjs` framework (tested by its own suite). Runs in the
 * packages/app vitest suite.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDeviceDeployCommand,
  buildDeviceFailureBootTraceCommand,
  buildDeviceFailureScreenshotCommand,
  buildDeviceLogsCommand,
  buildDeviceSmokeCommand,
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

describe("buildDeviceFailureScreenshotCommand", () => {
  it("uses idevicescreenshot against the physical device UDID", () => {
    const { cmd, args } = buildDeviceFailureScreenshotCommand({
      deviceUdid: deviceId,
      outputFile: "/bundle/failure/screen.png",
    });
    expect(cmd).toBe("idevicescreenshot");
    expect(args).toEqual(["--udid", deviceId, "/bundle/failure/screen.png"]);
  });
  it("throws without an output file", () => {
    expect(() =>
      buildDeviceFailureScreenshotCommand({ deviceUdid: deviceId }),
    ).toThrow(/outputFile is required/);
  });
});

describe("buildDeviceFailureBootTraceCommand", () => {
  it("reuses the no-console boot-trace pull path for failure forensics", () => {
    const { args } = buildDeviceFailureBootTraceCommand({
      scriptsDir,
      deviceId,
      outputFile: "/bundle/failure/boot-trace-run",
      bundleId: "ai.elizaos.app",
    });
    expect(args).toEqual([
      path.join(scriptsDir, "ios-device-logs.mjs"),
      "--device",
      deviceId,
      "--no-console",
      "--pull-boot-trace",
      "--output",
      "/bundle/failure/boot-trace-run",
      "--bundle-id",
      "ai.elizaos.app",
    ]);
  });
});
