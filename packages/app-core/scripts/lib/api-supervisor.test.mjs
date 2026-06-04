import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiSupervisor } from "./api-supervisor.mjs";

function makeChild() {
  const child = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function setup(overrides = {}) {
  const spawned = [];
  const terminate = vi.fn();
  const onGiveUp = vi.fn();
  let shuttingDown = false;
  const sup = createApiSupervisor({
    spawnChild: () => {
      const child = makeChild();
      spawned.push(child);
      return child;
    },
    onGiveUp,
    isShuttingDown: () => shuttingDown,
    terminate,
    log: () => {},
    warn: () => {},
    respawnDelayMs: 10,
    ...overrides,
  });
  return {
    sup,
    spawned,
    terminate,
    onGiveUp,
    setShutdown: (value) => {
      shuttingDown = value;
    },
    last: () => spawned[spawned.length - 1],
  };
}

describe("createApiSupervisor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("relaunches after an unintentional exit", () => {
    const { sup, spawned } = setup();
    sup.start();
    expect(spawned).toHaveLength(1);
    spawned[0].emit("exit", 1);
    vi.advanceTimersByTime(20);
    expect(spawned).toHaveLength(2);
  });

  it("gives up after exceeding the crash limit within the window", () => {
    const { sup, onGiveUp, last } = setup({ limit: 3, windowMs: 10_000 });
    sup.start();
    for (let i = 0; i < 5; i++) {
      last().emit("exit", 1);
      vi.advanceTimersByTime(20);
    }
    expect(onGiveUp).toHaveBeenCalled();
  });

  it("restart() bounces the child WITHOUT ever counting as a crash", () => {
    const { sup, spawned, terminate, onGiveUp } = setup({ limit: 3 });
    sup.start();
    // Far more intentional reloads than the crash limit, in a tight window.
    for (let i = 0; i < 12; i++) {
      const before = spawned.length;
      sup.restart();
      expect(terminate).toHaveBeenLastCalledWith(
        spawned[before - 1],
        "SIGTERM",
      );
      spawned[before - 1].emit("exit", 0); // child honors SIGTERM
      vi.advanceTimersByTime(20);
      expect(spawned).toHaveLength(before + 1);
    }
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("collapses overlapping restart() calls onto one in-flight kill", () => {
    const { sup, spawned, terminate } = setup();
    sup.start();
    sup.restart();
    sup.restart();
    sup.restart();
    expect(terminate).toHaveBeenCalledTimes(1);
    spawned[0].emit("exit", 0);
    vi.advanceTimersByTime(20);
    expect(spawned).toHaveLength(2);
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", () => {
    const { sup, spawned, terminate } = setup();
    sup.start();
    sup.restart();
    expect(terminate).toHaveBeenCalledWith(spawned[0], "SIGTERM");
    vi.advanceTimersByTime(4000);
    expect(terminate).toHaveBeenCalledWith(spawned[0], "SIGKILL");
  });

  it("restart() is a no-op during shutdown", () => {
    const { sup, terminate, setShutdown } = setup();
    sup.start();
    setShutdown(true);
    sup.restart();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("does not relaunch when the child exits during shutdown", () => {
    const { sup, spawned, setShutdown } = setup();
    sup.start();
    setShutdown(true);
    spawned[0].emit("exit", 0);
    vi.advanceTimersByTime(20);
    expect(spawned).toHaveLength(1);
  });
});
