/**
 * Verifies Steward child-process ownership across overlapping stop, start,
 * and crash-restart operations with deterministic mocked process boundaries.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./steward-sidecar/helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./steward-sidecar/helpers")>();
  return {
    ...actual,
    allocateFirstFreeLoopbackPort: vi.fn(async (port: number) => port),
  };
});

vi.mock("./steward-sidecar/process-management", () => ({
  findStewardEntryPoint: vi.fn(async () => "/fake/entry.js"),
  pipeOutput: vi.fn(),
}));

vi.mock("./steward-sidecar/health-check", () => ({
  waitForHealthy: vi.fn(async () => undefined),
}));

vi.mock("./steward-sidecar/wallet-setup", () => ({
  ensureWalletSetup: vi.fn(async () => ({
    tenantId: "tenant",
    tenantApiKey: "tenant-key",
    agentId: "agent",
    agentToken: "agent-token",
    walletAddress: "0x1234",
  })),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { StewardSidecar } from "./steward-sidecar";
import { allocateFirstFreeLoopbackPort } from "./steward-sidecar/helpers";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>;
    stdout: null;
    stderr: null;
    pid: number;
  };
  child.kill = vi.fn();
  child.stdout = null;
  child.stderr = null;
  child.pid = 4242;
  return child;
}

beforeEach(() => {
  // Force the Node child_process branch regardless of the runtime this
  // suite happens to execute under.
  vi.stubGlobal("Bun", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeSidecar() {
  return new StewardSidecar({
    dataDir: "/tmp/steward-sidecar-test",
    stewardEntryPoint: "/fake/entry.js",
  });
}

describe("StewardSidecar stop/restart race", () => {
  it("does not spawn a process when stop() runs during an in-flight crash-restart", async () => {
    vi.useFakeTimers();

    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let portCalls = 0;
    vi.mocked(allocateFirstFreeLoopbackPort).mockImplementation(
      async (port: number) => {
        portCalls++;
        if (portCalls === 1) {
          // The restart's spawnProcess() is now mid-flight -- hold it open so
          // stop() can run while it's still blocked here.
          await gate;
          return port + 1;
        }
        return port;
      },
    );
    vi.mocked(childProcess.spawn).mockImplementation(
      () => fakeChild() as never,
    );

    const sidecar = makeSidecar();
    // Drive the crash-restart path directly, the same way a real crash would
    // (handleCrash is private; cast to invoke it for this test).
    await (
      sidecar as unknown as {
        handleCrash: (code: number | null) => Promise<void>;
      }
    ).handleCrash(1);

    await vi.advanceTimersByTimeAsync(1_000); // INITIAL_BACKOFF_MS
    expect(portCalls).toBe(1);
    expect(childProcess.spawn).not.toHaveBeenCalled();

    await sidecar.stop();
    releaseGate?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(sidecar.getStatus().state).toBe("stopped");
    expect(sidecar.getApiBase()).toBe("http://127.0.0.1:3200");
  });

  it("does not let an obsolete restart resume after stop() followed by start()", async () => {
    vi.useFakeTimers();

    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let portCalls = 0;
    vi.mocked(allocateFirstFreeLoopbackPort).mockImplementation(
      async (port: number) => {
        portCalls++;
        if (portCalls === 1) {
          await gate;
          return port + 1;
        }
        return port;
      },
    );
    vi.mocked(childProcess.spawn).mockImplementation(
      () => fakeChild() as never,
    );

    const sidecar = makeSidecar();
    await (
      sidecar as unknown as {
        handleCrash: (code: number | null) => Promise<void>;
      }
    ).handleCrash(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(portCalls).toBe(1);

    await sidecar.stop();
    const startPromise = sidecar.start();
    await vi.advanceTimersByTimeAsync(0);
    await startPromise;
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(sidecar.getStatus().state).toBe("running");

    releaseGate?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(sidecar.getStatus().state).toBe("running");
    expect(sidecar.getApiBase()).toBe("http://127.0.0.1:3200");
  });

  it("coalesces overlapping start() calls into one child process", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    vi.mocked(allocateFirstFreeLoopbackPort).mockImplementation(
      async (port: number) => {
        await gate;
        return port;
      },
    );
    vi.mocked(childProcess.spawn).mockImplementation(
      () => fakeChild() as never,
    );

    const sidecar = makeSidecar();
    const firstStart = sidecar.start();
    const secondStart = sidecar.start();
    releaseGate?.();

    const [firstStatus, secondStatus] = await Promise.all([
      firstStart,
      secondStart,
    ]);

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(firstStatus.state).toBe("running");
    expect(secondStatus.state).toBe("running");
  });

  it("still restarts normally when stop() is never called", async () => {
    vi.useFakeTimers();
    vi.mocked(childProcess.spawn).mockImplementation(
      () => fakeChild() as never,
    );

    const sidecar = makeSidecar();
    await (
      sidecar as unknown as {
        handleCrash: (code: number | null) => Promise<void>;
      }
    ).handleCrash(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
  });
});
