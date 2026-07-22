/**
 * Exercises the iOS Cloud-onboarding harness in-process with a deterministic
 * Simulator command boundary, including its exact-device and evidence paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureIosSimulatorScreenshot: vi.fn(),
  execFileSync: vi.fn(),
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
  readFileSync: vi.fn(),
  runState: {
    mode: "tap" as "tap" | "autologin",
    runId: "00000000-0000-4000-8000-000000000001",
  },
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
vi.mock("node:crypto", () => ({
  default: { randomUUID: mocks.randomUUID },
  randomUUID: mocks.randomUUID,
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
  activeCloudApiBase,
  ensureSimulatorBooted,
  findSimulator,
  main,
  readSimulatorPreferenceString,
} from "../scripts/ios-cloud-onboarding-smoke.mjs";

const originalArgv = [...process.argv];
const originalEnv = { ...process.env };
const REQUEST_KEY = "eliza:ios-cloud-onboarding-smoke:request";
const RESULT_KEY = "eliza:ios-cloud-onboarding-smoke:result";
const RELAUNCH_RESULT_KEY = "eliza:ios-onboarding-relaunch-smoke:result";

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

function completedResult(
  overrides: Partial<{
    firstRunPostCount: number;
    firstRunPostExpectedCount: number;
    livenessExpectedReply: string;
    livenessReply: string;
    mode: "tap" | "autologin";
    runId: string;
    visual: { ready: true; notificationState?: string | null };
  }> = {},
) {
  return JSON.stringify({
    firstRunPostCount: 0,
    firstRunPostExpectedCount: 0,
    mode: mocks.runState.mode,
    ok: true,
    phase: "complete",
    runId: mocks.runState.runId,
    signInGreetingVisible: true,
    notificationRoute: { ok: true, status: 200 },
    permissionPriming: { shown: true, skipped: true, hidden: true },
    visual: { ready: true, notificationState: "empty" },
    storage: {
      "elizaos:active-server": JSON.stringify({
        kind: "cloud",
        apiBase: "https://agent.elizacloud.ai",
      }),
    },
    ...overrides,
  });
}

function completedRelaunchResult(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ok: true,
    phase: "complete",
    runId: mocks.runState.runId,
    homeVisible: true,
    composerVisible: true,
    onboardingHidden: true,
    permissionPrimingHidden: true,
    runtime: {
      startupPhase: "ready",
      agentState: "running",
      connected: true,
    },
    notificationRoute: { ok: true, status: 200 },
    visual: { ready: true, notificationState: "empty" },
    ...overrides,
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
  mocks.runState.mode = "tap";
  mocks.runState.runId = "00000000-0000-4000-8000-000000000001";
  spawnSync.mockImplementation((_command: string, args: string[]) => {
    const requestIndex = args.findIndex(
      (arg) => arg === REQUEST_KEY || arg === `CapacitorStorage.${REQUEST_KEY}`,
    );
    if (requestIndex >= 0) {
      const value = args[requestIndex + 2];
      if (typeof value === "string") {
        const request = JSON.parse(value) as {
          mode?: "tap" | "autologin";
          runId?: string;
        };
        if (request.mode) mocks.runState.mode = request.mode;
        if (request.runId) mocks.runState.runId = request.runId;
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  execFileSync.mockImplementation((command: string, args: string[]) => {
    if (args.join(" ").includes("list devices available --json")) {
      return simulatorInventory();
    }
    if (args.includes("get_app_container")) return "/sim/data/app";
    if (command === "plutil") {
      return JSON.stringify({
        [`CapacitorStorage.${RESULT_KEY}`]: completedResult(),
        [`CapacitorStorage.${RELAUNCH_RESULT_KEY}`]: completedRelaunchResult(),
      });
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
  it("accepts dedicated production and staging Cloud origins only", () => {
    const resultWithApiBase = (apiBase: string) => ({
      storage: {
        "elizaos:active-server": JSON.stringify({ kind: "cloud", apiBase }),
      },
    });

    expect(
      activeCloudApiBase(resultWithApiBase("https://agent-1.elizacloud.ai")),
    ).toBe("https://agent-1.elizacloud.ai");
    expect(
      activeCloudApiBase(
        resultWithApiBase("https://agent-1.staging.elizacloud.ai"),
      ),
    ).toBe("https://agent-1.staging.elizacloud.ai");
    expect(() =>
      activeCloudApiBase(
        resultWithApiBase(
          "https://agent-1.staging.elizacloud.ai.attacker.test",
        ),
      ),
    ).toThrow("invalid API base");
  });

  it("reads the app plist before a stale defaults cache", () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") {
        return JSON.stringify({
          [`CapacitorStorage.${RESULT_KEY}`]: completedResult(),
        });
      }
      if (args.includes("read")) {
        return JSON.stringify({ ok: false, phase: "requested" });
      }
      return "";
    });

    expect(
      readSimulatorPreferenceString("LANE-UDID", "ai.elizaos.app", RESULT_KEY),
    ).toBe(completedResult());
    expect(
      execFileSync.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("read"),
      ),
    ).toBe(false);
  });

  it("treats a missing plist key as removed despite a stale defaults cache", () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") return JSON.stringify({});
      if (args.includes("read")) return "stale-request";
      return "";
    });

    expect(
      readSimulatorPreferenceString(
        "LANE-UDID",
        "ai.elizaos.app",
        REQUEST_KEY,
        { authoritativePlistAbsence: true },
      ),
    ).toBeNull();
    expect(
      execFileSync.mock.calls.some(
        ([, args]) => Array.isArray(args) && args.includes("read"),
      ),
    ).toBe(false);
  });

  it("falls back to cfprefsd for a newly written result not yet in the plist", () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") return JSON.stringify({});
      if (args.includes("read")) return "fresh-result";
      return "";
    });

    expect(
      readSimulatorPreferenceString("LANE-UDID", "ai.elizaos.app", RESULT_KEY),
    ).toBe("fresh-result");
  });

  it("runs tap and autologin through install, launch, result, and capture", async () => {
    await expect(main()).resolves.toBeUndefined();

    expect(startIosSimulatorVideo).toHaveBeenCalledTimes(4);
    expect(stopVideo).toHaveBeenCalledTimes(4);
    expect(captureIosSimulatorScreenshot).toHaveBeenCalledTimes(6);
    expect(stopVideo.mock.invocationCallOrder[0]).toBeLessThan(
      captureIosSimulatorScreenshot.mock.invocationCallOrder[1],
    );
    expect(stopVideo.mock.invocationCallOrder[1]).toBeLessThan(
      captureIosSimulatorScreenshot.mock.invocationCallOrder[2],
    );
    expect(stopVideo.mock.invocationCallOrder[2]).toBeLessThan(
      captureIosSimulatorScreenshot.mock.invocationCallOrder[4],
    );
    expect(stopVideo.mock.invocationCallOrder[3]).toBeLessThan(
      captureIosSimulatorScreenshot.mock.invocationCallOrder[5],
    );
    const framebufferSettles = vi
      .mocked(globalThis.setTimeout)
      .mock.calls.map((args, index) => ({
        delay: args[1],
        order: vi.mocked(globalThis.setTimeout).mock.invocationCallOrder[index],
      }))
      .filter(({ delay }) => delay === 1_500);
    expect(framebufferSettles).toHaveLength(2);
    expect(framebufferSettles[0]?.order).toBeGreaterThan(
      stopVideo.mock.invocationCallOrder[1],
    );
    expect(framebufferSettles[0]?.order).toBeLessThan(
      captureIosSimulatorScreenshot.mock.invocationCallOrder[2],
    );
    expect(framebufferSettles[1]?.order).toBeGreaterThan(
      stopVideo.mock.invocationCallOrder[3],
    );
    expect(framebufferSettles[1]?.order).toBeLessThan(
      captureIosSimulatorScreenshot.mock.invocationCallOrder[5],
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "install", "LANE-UDID", "/build/App.app"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "keychain", "LANE-UDID", "reset"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", "LANE-UDID", "ai.elizaos.app"],
      expect.any(Object),
    );
  });

  it("rejects a first-run submission count that contradicts the selected backend", async () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.join(" ").includes("list devices available --json")) {
        return simulatorInventory();
      }
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") {
        return JSON.stringify({
          [`CapacitorStorage.${RESULT_KEY}`]: completedResult({
            firstRunPostCount: 1,
          }),
        });
      }
      return "";
    });

    await expect(main()).rejects.toThrow(
      "expected 0 /api/first-run POSTs for the selected backend, got 1",
    );
  });

  it("rejects a live reply that is not correlated to the current run", async () => {
    process.argv.push("--liveness");
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.join(" ").includes("list devices available --json")) {
        return simulatorInventory();
      }
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") {
        return JSON.stringify({
          [`CapacitorStorage.${RESULT_KEY}`]: completedResult({
            livenessExpectedReply: "IOS-CLOUD-00000000",
            livenessReply: "an older conversation reply",
          }),
          [`CapacitorStorage.${RELAUNCH_RESULT_KEY}`]:
            completedRelaunchResult(),
        });
      }
      return "";
    });

    await expect(main()).rejects.toThrow("was not correlated to run");
  });

  it("rejects a visible notification failure even when the route probe passed", async () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.join(" ").includes("list devices available --json")) {
        return simulatorInventory();
      }
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") {
        return JSON.stringify({
          [`CapacitorStorage.${RESULT_KEY}`]: completedResult({
            visual: {
              ready: true,
              notificationState: "unavailable",
            },
          }),
        });
      }
      return "";
    });

    await expect(main()).rejects.toThrow("lacked a healthy notification state");
  });

  it("rejects a missing notification state instead of treating visual ready as sufficient", async () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.join(" ").includes("list devices available --json")) {
        return simulatorInventory();
      }
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") {
        return JSON.stringify({
          [`CapacitorStorage.${RESULT_KEY}`]: completedResult({
            visual: { ready: true },
          }),
        });
      }
      return "";
    });

    await expect(main()).rejects.toThrow("lacked a healthy notification state");
  });

  it("rejects an unknown cold-relaunch notification state", async () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.join(" ").includes("list devices available --json")) {
        return simulatorInventory();
      }
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") {
        return JSON.stringify({
          [`CapacitorStorage.${RESULT_KEY}`]: completedResult(),
          [`CapacitorStorage.${RELAUNCH_RESULT_KEY}`]: completedRelaunchResult({
            visual: { ready: true, notificationState: "unknown" },
          }),
        });
      }
      return "";
    });

    await expect(main()).rejects.toThrow("cold relaunch lacked a clean home");
  });

  it("refuses to cold relaunch while the one-shot request remains pending", async () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (args.join(" ").includes("list devices available --json")) {
        return simulatorInventory();
      }
      if (args.includes("get_app_container")) return "/sim/data/app";
      if (command === "plutil") {
        return JSON.stringify({
          [`CapacitorStorage.${REQUEST_KEY}`]: JSON.stringify({
            mode: mocks.runState.mode,
            runId: mocks.runState.runId,
          }),
          [`CapacitorStorage.${RESULT_KEY}`]: completedResult(),
        });
      }
      return "";
    });

    await expect(main()).rejects.toThrow("did not consume its one-shot");
    expect(
      spawnSync.mock.calls.some(
        ([, args]) =>
          Array.isArray(args) &&
          args.some((arg) =>
            String(arg).includes("ios-onboarding-relaunch-smoke:request"),
          ),
      ),
    ).toBe(false);
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
