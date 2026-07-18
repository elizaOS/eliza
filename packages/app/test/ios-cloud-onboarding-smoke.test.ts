/**
 * Exercises the iOS Cloud-onboarding harness in-process with a deterministic
 * Simulator command boundary, including its exact-device and evidence paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureIosSimulatorScreenshot: vi.fn(),
  execFileSync: vi.fn(),
  readFileSync: vi.fn(),
  spawnSync: vi.fn(),
  startIosSimulatorVideo: vi.fn(),
  stopVideo: vi.fn(async () => "/evidence/cloud-onboarding.mov"),
}));

const {
  captureIosSimulatorScreenshot,
  execFileSync,
  readFileSync,
  spawnSync,
  startIosSimulatorVideo,
  stopVideo,
} = mocks;

vi.mock("node:child_process", () => ({
  default: {
    execFileSync: mocks.execFileSync,
    spawnSync: mocks.spawnSync,
  },
  execFileSync: mocks.execFileSync,
  spawnSync: mocks.spawnSync,
}));
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readFileSync: mocks.readFileSync,
    rmSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: 1 })),
    writeFileSync: vi.fn(),
  },
}));
vi.mock("../scripts/lib/ios-simulator-capture.mjs", () => ({
  captureIosSimulatorScreenshot: mocks.captureIosSimulatorScreenshot,
  startIosSimulatorVideo: mocks.startIosSimulatorVideo,
}));

import {
  ensureSimulatorBooted,
  findSimulator,
  main,
} from "../scripts/ios-cloud-onboarding-smoke.mjs";

const originalArgv = [...process.argv];
const originalEnv = { ...process.env };

function simulatorInventory(state = "Booted") {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        {
          isAvailable: true,
          name: "iPhone 17 Pro",
          state,
          udid: "LANE-UDID",
        },
        {
          isAvailable: true,
          name: "iPhone 17",
          state: "Booted",
          udid: "OTHER-UDID",
        },
      ],
    },
  });
}

function completedResult() {
  return JSON.stringify({
    firstRunPostCount: 1,
    ok: true,
    phase: "complete",
    signInGreetingVisible: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  startIosSimulatorVideo.mockReturnValue({ stop: stopVideo });
  process.argv = [
    "node",
    "/repo/packages/app/scripts/ios-cloud-onboarding-smoke.mjs",
    "--device",
    "LANE-UDID",
    "--app-path",
    "/build/App.app",
    "--mode",
    "both",
  ];
  process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE = "1";
  process.env.IOS_CLOUD_ONBOARDING_ATTEMPTS = "1";
  process.env.IOS_CLOUD_ONBOARDING_DELAY_MS = "0";
  readFileSync.mockReturnValue('appId: "ai.elizaos.app"');
  spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  execFileSync.mockImplementation((_command, args: string[]) => {
    if (args.join(" ").includes("list devices available --json")) {
      return simulatorInventory();
    }
    if (args.includes("read")) return completedResult();
    return "";
  });
  captureIosSimulatorScreenshot.mockReturnValue("/evidence/screenshot.png");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
    if (typeof callback === "function") callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  });
});

afterEach(() => {
  process.argv = [...originalArgv];
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("dedicated Simulator selection", () => {
  it("matches only the requested UDID or exact device name", () => {
    expect(findSimulator("LANE-UDID")).toMatchObject({ udid: "LANE-UDID" });
    expect(findSimulator("iPhone 17 Pro")).toMatchObject({
      udid: "LANE-UDID",
    });
    expect(findSimulator("iPhone")).toBeNull();
  });

  it("fails closed when no lane device is declared or available", () => {
    process.argv = process.argv.slice(0, 2);
    delete process.env.ELIZA_IOS_SIMULATOR_UDID;
    expect(() => ensureSimulatorBooted()).toThrow(
      "requires an exact simulator",
    );

    process.argv.push("--device", "MISSING-UDID");
    expect(() => ensureSimulatorBooted()).toThrow("is not available");
  });

  it("boots and waits for an available lane Simulator", () => {
    execFileSync.mockImplementation((_command, args: string[]) => {
      if (args.join(" ").includes("list devices available --json")) {
        return simulatorInventory("Shutdown");
      }
      return "";
    });

    expect(ensureSimulatorBooted()).toBe("LANE-UDID");
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "boot", "LANE-UDID"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "bootstatus", "LANE-UDID", "-b"],
      expect.any(Object),
    );
  });
});

describe("Cloud onboarding orchestration", () => {
  it("runs tap and autologin through install, launch, result, and capture", async () => {
    await expect(main()).resolves.toBeUndefined();

    expect(startIosSimulatorVideo).toHaveBeenCalledTimes(2);
    expect(stopVideo).toHaveBeenCalledTimes(2);
    expect(captureIosSimulatorScreenshot).toHaveBeenCalledTimes(4);
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "install", "LANE-UDID", "/build/App.app"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", "LANE-UDID", "ai.elizaos.app"],
      expect.any(Object),
    );
  });

  it("refuses accidental non-live execution", async () => {
    delete process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE;
    await expect(main()).rejects.toThrow(
      "Set ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE=1",
    );
  });

  it("rejects unsupported run modes before touching the app", async () => {
    const modeIndex = process.argv.indexOf("--mode");
    process.argv[modeIndex + 1] = "unknown";
    await expect(main()).rejects.toThrow("Unsupported --mode unknown");
  });
});
