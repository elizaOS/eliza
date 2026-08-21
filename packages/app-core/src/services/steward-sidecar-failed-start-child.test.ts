/**
 * Steward child-process ownership when a lifecycle fails AFTER the spawn.
 *
 * `spawnProcess` publishes `this.process` as soon as the child exists, which is
 * before `waitForHealthy` and `ensureWalletSetup` run. `stop()` is the only
 * other path that kills the child, and the failing lifecycle never calls it —
 * so before this fix a failed start left a live steward bound to the port with
 * the wallet database open, and the next `start()` overwrote the only reference
 * to it. These pin that the child is reclaimed instead, and that reclaiming it
 * is not mistaken for a crash.
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
import { waitForHealthy } from "./steward-sidecar/health-check";
import { ensureWalletSetup } from "./steward-sidecar/wallet-setup";

type FakeChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  stdout: null;
  stderr: null;
  pid: number;
};

/** Every child handed to the sidecar during one test, in spawn order. */
let spawnedChildren: FakeChild[];

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.kill = vi.fn();
  child.stdout = null;
  child.stderr = null;
  child.pid = pid;
  return child;
}

beforeEach(() => {
  // Force the Node child_process branch regardless of the runtime this suite
  // happens to execute under.
  vi.stubGlobal("Bun", undefined);
  spawnedChildren = [];
  vi.mocked(childProcess.spawn).mockImplementation((() => {
    const child = fakeChild(5000 + spawnedChildren.length);
    spawnedChildren.push(child);
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  }) as unknown as typeof childProcess.spawn);
  vi.mocked(waitForHealthy).mockResolvedValue(undefined);
  vi.mocked(ensureWalletSetup).mockResolvedValue({
    tenantId: "tenant",
    tenantApiKey: "tenant-key",
    agentId: "agent",
    agentToken: "agent-token",
    walletAddress: "0x1234",
  } as Awaited<ReturnType<typeof ensureWalletSetup>>);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeSidecar() {
  return new StewardSidecar({
    dataDir: "/tmp/steward-sidecar-failed-start-test",
    stewardEntryPoint: "/fake/entry.js",
  });
}

async function expectStartToFail(sidecar: StewardSidecar) {
  await expect(sidecar.start()).rejects.toThrow();
}

describe("StewardSidecar: a lifecycle that fails after the spawn", () => {
  it("kills the child when the health check never succeeds", async () => {
    vi.mocked(waitForHealthy).mockRejectedValue(new Error("health timeout"));
    const sidecar = makeSidecar();

    await expectStartToFail(sidecar);

    expect(spawnedChildren).toHaveLength(1);
    expect(spawnedChildren[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(sidecar.getStatus().state).toBe("error");
    expect(sidecar.getStatus().pid).toBeNull();
  });

  it("kills the child when wallet setup fails", async () => {
    vi.mocked(ensureWalletSetup).mockRejectedValue(new Error("wallet failed"));
    const sidecar = makeSidecar();

    await expectStartToFail(sidecar);

    expect(spawnedChildren).toHaveLength(1);
    expect(spawnedChildren[0].kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not strand the first child when start is retried after a failure", async () => {
    // `startSteward()` only skips when the state is "running", so a retry after
    // a failed start reaches spawnProcess again. Before the fix that overwrote
    // the only reference to the first child, which then outlived the app.
    vi.mocked(waitForHealthy).mockRejectedValueOnce(
      new Error("health timeout"),
    );
    const sidecar = makeSidecar();

    await expectStartToFail(sidecar);
    const status = await sidecar.start();

    expect(spawnedChildren).toHaveLength(2);
    expect(spawnedChildren[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(status.state).toBe("running");
  });

  it("does not read the reclaimed child's exit as a crash", async () => {
    vi.useFakeTimers();
    vi.mocked(waitForHealthy).mockRejectedValue(new Error("health timeout"));
    const sidecar = makeSidecar();

    await expectStartToFail(sidecar);
    expect(spawnedChildren).toHaveLength(1);

    // The child now exits because we killed it. That must not enter the
    // restart backoff and spawn a replacement.
    spawnedChildren[0].emit("exit", 143);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnedChildren).toHaveLength(1);
    expect(sidecar.getStatus().state).toBe("error");
    expect(sidecar.getStatus().restartCount).toBe(0);
  });

  it("kills the child when a crash-restart attempt fails its health check", async () => {
    vi.useFakeTimers();
    const sidecar = makeSidecar();

    await sidecar.start();
    expect(spawnedChildren).toHaveLength(1);

    // The running child crashes; the restart attempt then fails to come up.
    vi.mocked(waitForHealthy).mockRejectedValue(new Error("health timeout"));
    spawnedChildren[0].emit("exit", 1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(spawnedChildren).toHaveLength(2);
    expect(spawnedChildren[1].kill).toHaveBeenCalledWith("SIGTERM");
    expect(sidecar.getStatus().state).toBe("error");
  });

  it("leaves a healthy start untouched", async () => {
    const sidecar = makeSidecar();

    const status = await sidecar.start();

    expect(status.state).toBe("running");
    expect(spawnedChildren).toHaveLength(1);
    expect(spawnedChildren[0].kill).not.toHaveBeenCalled();
    expect(status.pid).toBe(5000);
  });

  it("still kills the child on an explicit stop after a healthy start", async () => {
    const sidecar = makeSidecar();

    await sidecar.start();
    const stopped = sidecar.stop();
    spawnedChildren[0].emit("exit", 0);
    await stopped;

    expect(spawnedChildren[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(sidecar.getStatus().state).toBe("stopped");
  });
});
