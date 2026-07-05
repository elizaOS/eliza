/**
 * Unit coverage for the physical iOS device e2e command planner.
 *
 * The real lane needs macOS, signing material, and a paired phone. These tests
 * pin the no-device contract: deploy is main-app-only by default, capture uses
 * the freshly staged app path, and logs use the boot-trace path that avoids the
 * console-mode full-Bun SIGTRAP.
 */
import { describe, expect, it } from "vitest";
import {
  buildPhysicalIosDevicePlan,
  parseIosDeviceE2eArgs,
} from "./lib/ios-device-e2e-plan.mjs";

const PATHS = {
  stagingDir: "/tmp/bundle/raw/device-deploy-stage",
  stagedApp: "/tmp/bundle/raw/device-deploy-stage/App.app",
  captureDir: "/tmp/bundle/raw/ios-device-capture",
  bootTraceOutput: "/tmp/bundle/logs/ios-device-boot-trace.log",
};

describe("parseIosDeviceE2eArgs", () => {
  it("defaults to the unattended main-app physical lane", () => {
    expect(parseIosDeviceE2eArgs([])).toEqual({
      device: undefined,
      output: undefined,
      skipBuild: false,
      noLaunch: false,
      includeAppexes: false,
      noWait: false,
      bundleId: undefined,
      identity: undefined,
      derivedData: undefined,
      configuration: undefined,
      onlyTesting: undefined,
    });
  });

  it("parses device, output, signing, and test narrowing flags", () => {
    const parsed = parseIosDeviceE2eArgs([
      "--device",
      "phone",
      "--output",
      "/tmp/out",
      "--skip-build",
      "--no-launch",
      "--include-appexes",
      "--no-wait",
      "--bundle-id",
      "ai.elizaos.app",
      "--identity",
      "ABC",
      "--derived-data",
      "/tmp/dd",
      "--configuration",
      "Release",
      "--only-testing",
      "AppUITests/BootCaptureUITests",
    ]);
    expect(parsed).toMatchObject({
      device: "phone",
      output: "/tmp/out",
      skipBuild: true,
      noLaunch: true,
      includeAppexes: true,
      noWait: true,
      bundleId: "ai.elizaos.app",
      identity: "ABC",
      derivedData: "/tmp/dd",
      configuration: "Release",
      onlyTesting: "AppUITests/BootCaptureUITests",
    });
  });
});

describe("buildPhysicalIosDevicePlan", () => {
  it("deploys with --skip-appexes by default, captures staged app, and pulls boot trace", () => {
    const plan = buildPhysicalIosDevicePlan(
      parseIosDeviceE2eArgs(["--device", "phone"]),
      PATHS,
    );
    expect(plan.map((step) => step.id)).toEqual(["deploy", "capture", "logs"]);
    expect(plan[0].args).toContain("--skip-appexes");
    expect(plan[0].args).toEqual(
      expect.arrayContaining([
        "--staging",
        PATHS.stagingDir,
        "--device",
        "phone",
      ]),
    );
    expect(plan[1].args).toEqual(
      expect.arrayContaining([
        "--platform",
        "device",
        "--app-path",
        PATHS.stagedApp,
        "--strict-gate",
        "--require-chat",
      ]),
    );
    expect(plan[2].args).toEqual(
      expect.arrayContaining([
        "--no-console",
        "--pull-boot-trace",
        "--output",
        PATHS.bootTraceOutput,
      ]),
    );
  });

  it("keeps appexes when explicitly requested", () => {
    const plan = buildPhysicalIosDevicePlan(
      parseIosDeviceE2eArgs(["--include-appexes"]),
      PATHS,
    );
    expect(plan[0].args).not.toContain("--skip-appexes");
  });
});
