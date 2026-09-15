/** Deterministic coverage for bounded deferred-route capability recovery. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client-types-core";
import {
  isCapabilityWarmupMiss,
  loadAfterCapabilityWarmup,
} from "./runtime-capability-retry";

function routeMissing(code?: string): ApiError {
  return new ApiError({
    kind: "http",
    path: "/api/example",
    message: "Not found",
    status: 404,
    code,
  });
}

afterEach(() => vi.useRealTimers());

describe("runtime capability warm-up", () => {
  it("recovers when a deferred route appears within the retry bound", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(routeMissing("resource_not_found"))
      .mockRejectedValueOnce(routeMissing("resource_not_found"))
      .mockResolvedValue("ready");

    const result = loadAfterCapabilityWarmup(load, { delaysMs: [10, 20] });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe("ready");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("preserves a stable missing-route error after the retry bound", async () => {
    vi.useFakeTimers();
    const missing = routeMissing("resource_not_found");
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(missing);

    const result = loadAfterCapabilityWarmup(load, { delaysMs: [10, 20] });
    const rejection = expect(result).rejects.toBe(missing);
    await vi.runAllTimersAsync();

    await rejection;
    expect(load).toHaveBeenCalledTimes(3);
  });

  it.each([
    "documents_runtime_unavailable",
    "memory_runtime_unavailable",
    "relationships_runtime_unavailable",
    "trajectories_runtime_unavailable",
  ])("does not retry the typed %s capability boundary", async (code) => {
    const unavailable = routeMissing(code);
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(unavailable);

    expect(isCapabilityWarmupMiss(unavailable)).toBe(false);
    await expect(
      loadAfterCapabilityWarmup(load, { delaysMs: [10, 20] }),
    ).rejects.toBe(unavailable);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending warm-up delay before it can retry a repointed client", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(routeMissing("resource_not_found"));

    const result = loadAfterCapabilityWarmup(load, {
      delaysMs: [1_000],
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects a response that resolves after its lifecycle was aborted", async () => {
    const controller = new AbortController();
    let resolveLoad: ((value: string) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve;
        }),
    );

    const result = loadAfterCapabilityWarmup(load, {
      signal: controller.signal,
    });
    controller.abort();
    resolveLoad?.("wrong authority");

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
