import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: spawnMock,
}));

import {
  CommandLane,
  clearCommandLane,
  enqueueCommand,
  getQueueSize,
  runCommandWithTimeout,
} from "./processQueue";

function fakeChild() {
  const child = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.killed = false;
  child.stdout = { on: vi.fn() };
  child.stderr = { on: vi.fn() };
  child.stdin = { write: vi.fn(), end: vi.fn() };
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  clearCommandLane(CommandLane.Main);
  vi.useRealTimers();
});

describe("runCommandWithTimeout timeout contract", () => {
  it("defaults the command timeout to 10s instead of killing immediately when timeoutMs is omitted", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runCommandWithTimeout(["node", "-e", "1"], {
      input: "x",
    });

    // Well before any sensible default, the child must not be SIGKILLed.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", null, "SIGKILL");
    const result = await promise;
    expect(result.killed).toBe(true);
  });

  it("honors an explicit numeric timeout", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runCommandWithTimeout(["node", "-e", "1"], 5_000);

    await vi.advanceTimersByTimeAsync(4_900);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.emit("close", null, "SIGKILL");
    await promise;
  });

  it("resolves with stdout/stderr/code on clean close", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const promise = runCommandWithTimeout(["echo", "hi"], { timeoutMs: 1000 });
    child.stdout.on.mock.calls[0][1](Buffer.from("hello\n"));
    child.stderr.on.mock.calls[0][1](Buffer.from(""));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result.stdout).toBe("hello\n");
    expect(result.code).toBe(0);
    expect(result.killed).toBe(false);
  });
});

describe("command lane queue", () => {
  it("serializes tasks within the main lane and reports queued + active", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p1 = enqueueCommand(async () => {
      order.push("a-start");
      await firstGate;
      order.push("a-end");
      return 1;
    });
    const p2 = enqueueCommand(async () => {
      order.push("b");
      return 2;
    });

    await vi.waitFor(() => expect(order).toContain("a-start"));
    expect(order).not.toContain("b");
    expect(getQueueSize(CommandLane.Main)).toBe(2);

    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    expect(getQueueSize(CommandLane.Main)).toBe(0);
  });

  it("propagates task failures to the awaiting caller", async () => {
    const p = enqueueCommand(async () => {
      throw new Error("task boom");
    });
    await expect(p).rejects.toThrow("task boom");
    expect(getQueueSize(CommandLane.Main)).toBe(0);
  });
});
