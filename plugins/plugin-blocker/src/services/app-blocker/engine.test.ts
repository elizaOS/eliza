import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCachedAppBlockerStatus,
  type NativeAppBlockerBackend,
  registerNativeAppBlockerBackend,
  startAppBlock,
  stopAppBlock,
} from "./engine.ts";
import type { AppBlockerStatus } from "./types.ts";

function status(active: boolean): AppBlockerStatus {
  return {
    available: true,
    active,
    platform: "android",
    engine: "usage-stats-overlay",
    blockedCount: active ? 1 : 0,
    blockedPackageNames: active ? ["example.app"] : [],
    endsAt: null,
    permissionStatus: "granted",
  };
}

function backend(active: boolean): NativeAppBlockerBackend {
  return {
    getStatus: vi.fn(async () => status(active)),
    checkPermissions: async () => ({ status: "granted", canRequest: false }),
    requestPermissions: async () => ({ status: "granted", canRequest: false }),
    getInstalledApps: async () => ({ apps: [] }),
    selectApps: async () => ({ apps: [], cancelled: false }),
    blockApps: async () => ({ success: true, endsAt: null, blockedCount: 1 }),
    unblockApps: async () => ({ success: true }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => {
  registerNativeAppBlockerBackend(null as unknown as NativeAppBlockerBackend);
});

describe("app blocker status cache", () => {
  it.each(["start", "stop"] as const)(
    "does not cache a stale read completing after %s",
    async (operation) => {
      const active = operation === "start";
      const native = backend(active);
      const stale = deferred<AppBlockerStatus>();
      vi.mocked(native.getStatus).mockImplementationOnce(() => stale.promise);
      registerNativeAppBlockerBackend(native);
      const pending = getCachedAppBlockerStatus();
      if (operation === "start") await startAppBlock({});
      else await stopAppBlock();
      stale.resolve(status(!active));
      await pending;
      expect((await getCachedAppBlockerStatus()).active).toBe(active);
      await getCachedAppBlockerStatus();
      expect(native.getStatus).toHaveBeenCalledTimes(2);
    },
  );

  it("does not cache an old backend response after replacement", async () => {
    const stale = deferred<AppBlockerStatus>();
    const previous = backend(false);
    vi.mocked(previous.getStatus).mockImplementationOnce(() => stale.promise);
    registerNativeAppBlockerBackend(previous);
    const pending = getCachedAppBlockerStatus();
    const replacement = backend(true);
    registerNativeAppBlockerBackend(replacement);
    stale.resolve(status(false));
    await pending;
    expect((await getCachedAppBlockerStatus()).active).toBe(true);
    expect(replacement.getStatus).toHaveBeenCalledTimes(1);
  });

  it("invalidates reads started during a mutation even when it fails", async () => {
    const stale = deferred<AppBlockerStatus>();
    const finishMutation = deferred<void>();
    const native = backend(true);
    vi.mocked(native.getStatus).mockImplementationOnce(() => stale.promise);
    native.blockApps = async () => {
      await finishMutation.promise;
      throw new Error("native mutation failed after changing status");
    };
    registerNativeAppBlockerBackend(native);
    const mutation = startAppBlock({});
    const rejection = expect(mutation).rejects.toThrow(
      "native mutation failed",
    );
    const pending = getCachedAppBlockerStatus();
    finishMutation.resolve();
    await rejection;
    stale.resolve(status(false));
    await pending;
    expect((await getCachedAppBlockerStatus()).active).toBe(true);
    expect(native.getStatus).toHaveBeenCalledTimes(2);
  });
});
