/**
 * Heartbeat & stale-run sweeper lifecycle tests for AppManager.
 *
 * The sweeper exists to handle the "user closed the tab" case: any plugin
 * that owns a setInterval (Defense-of-the-Agents game loop, 2004scape bot,
 * etc.) needs `stopRun` to be called even when the UI never sends an
 * explicit Stop. These tests pin that contract.
 *
 * The plugin route module is mocked at the import boundary so we can
 * observe `stopRun` invocations without spinning up a real plugin.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { AppRunSummary } from "../contracts/apps.js";
import { writeAppRunStore } from "./app-run-store.js";

const stopRunMock = vi.fn(async () => {});

vi.mock("./app-package-modules.js", () => ({
  importAppRouteModule: vi.fn(async () => ({
    stopRun: stopRunMock,
  })),
  importAppPlugin: vi.fn(async () => null),
}));

const { AppManager } = await import("./app-manager.js");

/**
 * Build a minimal AppRunSummary fixture. Only the fields the sweeper and
 * `stopRun` invocation care about are filled in; the rest are inert
 * defaults that satisfy the type but never get inspected by these tests.
 */
function makeRun(overrides: Partial<AppRunSummary>): AppRunSummary {
  const now = new Date().toISOString();
  return {
    runId: "run-1",
    appName: "@elizaos/app-defense-of-the-agents",
    displayName: "Defense of the Agents",
    pluginName: "@elizaos/app-defense-of-the-agents",
    launchType: "connect",
    launchUrl: null,
    viewer: null,
    session: null,
    characterId: null,
    agentId: null,
    status: "running",
    summary: null,
    startedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    supportsBackground: true,
    supportsViewerDetach: false,
    chatAvailability: "unknown",
    controlAvailability: "unknown",
    viewerAttachment: "unavailable",
    recentEvents: [],
    awaySummary: null,
    health: { state: "healthy", message: null },
    healthDetails: {
      checkedAt: now,
      auth: { state: "unknown", message: null },
      runtime: { state: "healthy", message: null },
      viewer: { state: "unknown", message: null },
      chat: { state: "unknown", message: null },
      control: { state: "unknown", message: null },
      message: null,
    },
    ...overrides,
  };
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "milady-app-manager-test-"));
  stopRunMock.mockClear();
  (stopRunMock as Mock).mockImplementation(async () => {});
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("AppManager.recordHeartbeat", () => {
  it("bumps lastHeartbeatAt without calling any plugin route", async () => {
    const stale = new Date(Date.now() - 60_000).toISOString();
    writeAppRunStore([makeRun({ lastHeartbeatAt: stale })], stateDir);

    const manager = new AppManager({ stateDir });
    const before = Date.now();
    const updated = manager.recordHeartbeat("run-1");
    const after = Date.now();

    expect(updated).not.toBeNull();
    expect(updated?.lastHeartbeatAt).not.toBe(stale);
    const bumpedAt = Date.parse(updated?.lastHeartbeatAt ?? "");
    expect(bumpedAt).toBeGreaterThanOrEqual(before);
    expect(bumpedAt).toBeLessThanOrEqual(after);
    expect(stopRunMock).not.toHaveBeenCalled();
  });

  it("returns null when the run is unknown", () => {
    const manager = new AppManager({ stateDir });
    expect(manager.recordHeartbeat("ghost-run-id")).toBeNull();
  });
});

describe("AppManager.reapStaleRuns", () => {
  it("stops runs whose heartbeat is older than the timeout and invokes stopRun", async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    writeAppRunStore(
      [
        makeRun({ runId: "run-fresh", lastHeartbeatAt: fresh }),
        makeRun({ runId: "run-stale", lastHeartbeatAt: stale }),
      ],
      stateDir,
    );

    const manager = new AppManager({
      stateDir,
      heartbeatTimeoutMs: 60_000,
    });

    const reaped = await manager.reapStaleRuns(null);

    expect(reaped.map((r) => r.runId)).toEqual(["run-stale"]);
    expect(stopRunMock).toHaveBeenCalledTimes(1);
    expect(stopRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "@elizaos/app-defense-of-the-agents",
        runId: "run-stale",
      }),
    );

    // The fresh run survives.
    const remaining = await manager.listRuns(null);
    expect(remaining.map((r) => r.runId)).toEqual(["run-fresh"]);
  });

  it("uses startedAt as the fallback when lastHeartbeatAt is null", async () => {
    const oldStart = new Date(Date.now() - 5 * 60_000).toISOString();
    writeAppRunStore(
      [
        makeRun({
          runId: "run-never-pinged",
          lastHeartbeatAt: null,
          startedAt: oldStart,
        }),
      ],
      stateDir,
    );

    const manager = new AppManager({
      stateDir,
      heartbeatTimeoutMs: 60_000,
    });

    const reaped = await manager.reapStaleRuns(null);

    expect(reaped.map((r) => r.runId)).toEqual(["run-never-pinged"]);
    expect(stopRunMock).toHaveBeenCalledTimes(1);
  });

  it("does not reap a freshly-launched run that has never received a heartbeat", async () => {
    const justNow = new Date().toISOString();
    writeAppRunStore(
      [
        makeRun({
          runId: "run-just-launched",
          lastHeartbeatAt: null,
          startedAt: justNow,
        }),
      ],
      stateDir,
    );

    const manager = new AppManager({
      stateDir,
      heartbeatTimeoutMs: 60_000,
    });

    const reaped = await manager.reapStaleRuns(null);
    expect(reaped).toEqual([]);
    expect(stopRunMock).not.toHaveBeenCalled();
  });

  it("removes a reaped run from disk so a fresh AppManager does not see it", async () => {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    writeAppRunStore(
      [makeRun({ runId: "run-stale", lastHeartbeatAt: stale })],
      stateDir,
    );

    const first = new AppManager({ stateDir, heartbeatTimeoutMs: 60_000 });
    await first.reapStaleRuns(null);

    const second = new AppManager({ stateDir, heartbeatTimeoutMs: 60_000 });
    expect(await second.listRuns(null)).toEqual([]);
  });

  it("continues reaping when stopRun throws — removal from the registry is authoritative", async () => {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    writeAppRunStore(
      [
        makeRun({ runId: "run-a", lastHeartbeatAt: stale }),
        makeRun({ runId: "run-b", lastHeartbeatAt: stale }),
      ],
      stateDir,
    );
    (stopRunMock as Mock).mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const manager = new AppManager({ stateDir, heartbeatTimeoutMs: 60_000 });
    const reaped = await manager.reapStaleRuns(null);

    expect(reaped.map((r) => r.runId).sort()).toEqual(["run-a", "run-b"]);
    expect(stopRunMock).toHaveBeenCalledTimes(2);
    expect(await manager.listRuns(null)).toEqual([]);
  });
});

describe("AppManager.startStaleRunSweeper", () => {
  it("reaps stale runs on each tick and is idempotent", async () => {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    writeAppRunStore(
      [makeRun({ runId: "run-stale", lastHeartbeatAt: stale })],
      stateDir,
    );

    // Use a very short real-timer interval so the sweeper actually fires
    // once without depending on vi.advanceTimersByTimeAsync (not
    // implemented by bun's vitest-compat shim).
    const manager = new AppManager({
      stateDir,
      heartbeatTimeoutMs: 60_000,
      heartbeatSweepIntervalMs: 50,
    });

    manager.startStaleRunSweeper(() => null);
    // Calling again should not start a second timer — easy to assert by
    // checking that only one stopRun fires per tick interval.
    manager.startStaleRunSweeper(() => null);

    // Wait long enough for at least one sweeper tick + the awaited reap
    // inside `runSweeperTick` to settle. 200ms >> 50ms tick interval.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(stopRunMock).toHaveBeenCalledTimes(1);
    expect(await manager.listRuns(null)).toEqual([]);

    manager.stopStaleRunSweeper();
    // Stopping is also idempotent.
    manager.stopStaleRunSweeper();
  });
});
