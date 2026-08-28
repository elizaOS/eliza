import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/selectors.js", () => ({
  anySelectorVisible: vi.fn(),
}));
vi.mock("./selectors.js", () => ({
  googleRemovalIndicators: ["[data-removed]"],
}));

import { anySelectorVisible } from "../shared/selectors.js";
import { startRemovalMonitor } from "./removal.js";

function fakePage() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    isClosed: vi.fn(() => false),
    once: vi.fn((event: string, callback: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(callback);
    }),
    off: vi.fn((event: string, callback: () => void) => {
      listeners.get(event)?.delete(callback);
    }),
    emit(event: string) {
      for (const callback of [...(listeners.get(event) ?? [])]) callback();
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

describe("startRemovalMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(anySelectorVisible).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never resolves when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const page = fakePage();
    let settled = false;
    startRemovalMonitor(page as never, controller.signal).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    expect(anySelectorVisible).not.toHaveBeenCalled();
    expect(page.listenerCount("close")).toBe(0);
  });

  it("resolves removed_by_admin when a removal indicator becomes visible", async () => {
    const page = fakePage();
    vi.mocked(anySelectorVisible)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const resolution = startRemovalMonitor(
      page as never,
      new AbortController().signal,
    ).then((reason) => reason);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(anySelectorVisible).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(resolution).resolves.toBe("removed_by_admin");
    // Polling stops after resolution: no further checks on the cadence.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(anySelectorVisible).toHaveBeenCalledTimes(2);
  });

  it("resolves removed_by_admin when the page closes under the bot", async () => {
    const page = fakePage();
    const resolution = startRemovalMonitor(
      page as never,
      new AbortController().signal,
    ).then((reason) => reason);
    await vi.advanceTimersByTimeAsync(1_500);
    page.emit("close");
    await expect(resolution).resolves.toBe("removed_by_admin");
  });

  it("stops polling and detaches the close listener on abort", async () => {
    const page = fakePage();
    const controller = new AbortController();
    let settled = false;
    startRemovalMonitor(page as never, controller.signal).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(page.listenerCount("close")).toBe(1);
    controller.abort();
    expect(page.off).toHaveBeenCalled();
    expect(page.listenerCount("close")).toBe(0);
    const callsAfterAbort = vi.mocked(anySelectorVisible).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(anySelectorVisible).toHaveBeenCalledTimes(callsAfterAbort);
    page.emit("close");
    expect(settled).toBe(false);
  });

  it("keeps polling when a selector check throws", async () => {
    const page = fakePage();
    vi.mocked(anySelectorVisible)
      .mockRejectedValueOnce(new Error("selector eval failed"))
      .mockResolvedValueOnce(true);
    const resolution = startRemovalMonitor(
      page as never,
      new AbortController().signal,
    ).then((reason) => reason);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(resolution).resolves.toBe("removed_by_admin");
    expect(anySelectorVisible).toHaveBeenCalledTimes(2);
  });

  it("polls at the 1.5s cadence until removed", async () => {
    const page = fakePage();
    const resolution = startRemovalMonitor(
      page as never,
      new AbortController().signal,
    ).then((reason) => reason);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(anySelectorVisible).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(anySelectorVisible).toHaveBeenCalledTimes(3);
    page.emit("close");
    await expect(resolution).resolves.toBe("removed_by_admin");
  });
});
