/** Verifies that backend source reloads survive boot gaps without restart storms. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentSourceReloadQueue } from "./agent-source-reload-queue.mjs";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(overrides = {}) {
  let shuttingDown = false;
  const restart = vi.fn();
  const onReload = vi.fn();
  const isReady = overrides.isReady ?? vi.fn().mockResolvedValue(true);
  const queue = createAgentSourceReloadQueue({
    restart,
    isShuttingDown: () => shuttingDown,
    onReload,
    retryMs: 100,
    ...overrides,
    isReady,
  });
  return {
    queue,
    restart,
    onReload,
    isReady,
    setShuttingDown(value) {
      shuttingDown = value;
    },
  };
}

describe("createAgentSourceReloadQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces normal and bulk source events into one ready restart", async () => {
    const { queue, restart, onReload, isReady } = setup();
    queue.requestReload({ relPath: "packages/core/src/a.ts", changedCount: 1 });
    queue.requestReload({
      relPath: "plugins/plugin-app-control/src/index.ts",
      changedCount: 18,
    });

    await flushMicrotasks();

    expect(isReady).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledWith({
      relPath: "plugins/plugin-app-control/src/index.ts",
      changedCount: 18,
    });
  });

  it("retains a reload while the agent boots and restarts once ready", async () => {
    let ready = false;
    const { queue, restart, isReady } = setup({
      isReady: vi.fn(async () => ready),
    });
    queue.requestReload({
      relPath: "plugins/plugin-app-control/src/actions/views.ts",
      changedCount: 1,
    });

    await flushMicrotasks();
    expect(restart).not.toHaveBeenCalled();
    expect(isReady).toHaveBeenCalledTimes(1);

    ready = true;
    await vi.advanceTimersByTimeAsync(100);

    expect(isReady).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("retries a failed readiness probe without losing the request", async () => {
    const isReady = vi
      .fn()
      .mockRejectedValueOnce(new Error("API child is between processes"))
      .mockResolvedValueOnce(true);
    const { queue, restart } = setup({ isReady });
    queue.requestReload({
      relPath: "packages/agent/src/index.ts",
      changedCount: 1,
    });

    await flushMicrotasks();
    expect(restart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(isReady).toHaveBeenCalledTimes(2);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("keeps an edit that arrives while the replacement child is booting", async () => {
    let ready = true;
    const { queue, restart } = setup({
      isReady: vi.fn(async () => ready),
    });
    queue.requestReload({
      relPath: "packages/agent/src/a.ts",
      changedCount: 1,
    });
    await flushMicrotasks();
    expect(restart).toHaveBeenCalledTimes(1);

    ready = false;
    queue.requestReload({
      relPath: "packages/agent/src/b.ts",
      changedCount: 1,
    });
    await flushMicrotasks();
    expect(restart).toHaveBeenCalledTimes(1);

    ready = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("cancels pending work when closed or shutting down", async () => {
    const isReady = vi.fn().mockResolvedValue(false);
    const first = setup({ isReady });
    first.queue.requestReload({
      relPath: "plugins/plugin-app-control/src/index.ts",
      changedCount: 1,
    });
    await flushMicrotasks();
    first.queue.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(first.restart).not.toHaveBeenCalled();

    const second = setup();
    second.setShuttingDown(true);
    second.queue.requestReload({
      relPath: "packages/core/src/index.ts",
      changedCount: 1,
    });
    await flushMicrotasks();
    expect(second.isReady).not.toHaveBeenCalled();
    expect(second.restart).not.toHaveBeenCalled();
  });
});
