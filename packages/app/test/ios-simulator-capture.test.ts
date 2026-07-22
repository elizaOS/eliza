/**
 * Exercises the real iOS Simulator capture helper across graceful, forced,
 * and terminal recording shutdowns with deterministic process boundaries.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 128 })),
}));

vi.mock("node:child_process", () => ({
  default: {
    spawn: mocks.spawn,
    spawnSync: mocks.spawnSync,
  },
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));
vi.mock("node:fs", () => ({
  default: {
    mkdirSync: mocks.mkdirSync,
    rmSync: mocks.rmSync,
    statSync: mocks.statSync,
  },
}));

import {
  availableIosSimulators,
  bootedIosSimulatorUdid,
  captureIosSimulatorScreenshot,
  startIosSimulatorVideo,
} from "../scripts/lib/ios-simulator-capture.mjs";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stderr = new EventEmitter();
  readonly kill = vi.fn<(signal: NodeJS.Signals) => boolean>(() => true);
}

const artifactDir = "/evidence/ios";
const localPath = `${artifactDir}/recording.mov`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.spawn.mockReset();
  mocks.spawnSync.mockReset();
  mocks.statSync.mockReset();
  mocks.statSync.mockReturnValue({ size: 128 });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("iOS Simulator discovery and still capture", () => {
  it("reads booted and available devices from simctl inventory", () => {
    mocks.spawnSync.mockImplementation((_command, args: string[]) => {
      const devices = args.includes("booted")
        ? [
            { name: "iPhone 17 Pro", state: "Booted", udid: "LANE-UDID" },
            { name: "iPhone 17", state: "Shutdown", udid: "OTHER-UDID" },
          ]
        : [
            {
              isAvailable: false,
              name: "Unavailable iPhone",
              state: "Shutdown",
              udid: "UNAVAILABLE-UDID",
            },
            {
              isAvailable: true,
              name: "iPhone 17 Pro",
              state: "Booted",
              udid: "LANE-UDID",
            },
          ];
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({ devices: { "iOS 26.5": devices } }),
      };
    });

    expect(bootedIosSimulatorUdid()).toBe("LANE-UDID");
    expect(availableIosSimulators()).toEqual([
      {
        isAvailable: true,
        name: "iPhone 17 Pro",
        state: "Booted",
        udid: "LANE-UDID",
      },
    ]);
  });

  it("returns a non-empty screenshot produced by simctl", () => {
    const invocations: Array<
      [string, string[], { encoding: string; stdio: string }]
    > = [];
    mocks.spawnSync.mockImplementation((command, args, options) => {
      invocations.push([command, args, options]);
      return { status: 0, stderr: "", stdout: "" };
    });
    const log = vi.fn();

    expect(
      captureIosSimulatorScreenshot({
        artifactDir,
        filename: "ready.png",
        log,
        target: "LANE-UDID",
      }),
    ).toBe(`${artifactDir}/ready.png`);
    expect(invocations).toEqual([
      [
        "xcrun",
        ["simctl", "io", "LANE-UDID", "screenshot", `${artifactDir}/ready.png`],
        { encoding: "utf8", stdio: "pipe" },
      ],
    ]);
    expect(log).toHaveBeenLastCalledWith(
      `wrote iOS simulator screenshot: ${artifactDir}/ready.png`,
    );
  });
});

describe("startIosSimulatorVideo", () => {
  it("returns a non-empty recording after a normal SIGINT close", async () => {
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGINT") child.emit("close", 0, signal);
      return true;
    });
    mocks.spawn.mockReturnValue(child);
    const log = vi.fn();

    const recording = startIosSimulatorVideo({
      artifactDir,
      log,
      target: "LANE-UDID",
    });
    const result = recording.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe(localPath);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    expect(log).toHaveBeenLastCalledWith(
      `wrote iOS simulator recording: ${localPath}`,
    );
  });

  it("uses SIGKILL when SIGINT does not close the recorder", async () => {
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") child.emit("close", null, signal);
      return true;
    });
    mocks.spawn.mockReturnValue(child);

    const result = startIosSimulatorVideo({ artifactDir }).stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBe(localPath);
    expect(child.kill.mock.calls).toEqual([["SIGINT"], ["SIGKILL"]]);
  });

  it("returns null and logs when neither signal closes the recorder", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const log = vi.fn();

    const result = startIosSimulatorVideo({
      artifactDir,
      log,
      target: "LANE-UDID",
    }).stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBeNull();
    expect(child.kill.mock.calls).toEqual([["SIGINT"], ["SIGKILL"]]);
    expect(log).toHaveBeenLastCalledWith(
      "iOS simulator recording did not stop for LANE-UDID",
    );
    expect(mocks.statSync).not.toHaveBeenCalled();
  });

  it("rejects an empty finalized recording and surfaces recorder stderr", async () => {
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGINT") child.emit("close", 0, signal);
      return true;
    });
    mocks.spawn.mockReturnValue(child);
    mocks.statSync.mockReturnValue({ size: 0 });
    const log = vi.fn();

    const recording = startIosSimulatorVideo({ artifactDir, log });
    child.stderr.emit("data", Buffer.from("recordVideo failed"));
    const result = recording.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toBeNull();
    expect(log).toHaveBeenLastCalledWith(
      "iOS simulator recording stderr: recordVideo failed",
    );
  });
});
