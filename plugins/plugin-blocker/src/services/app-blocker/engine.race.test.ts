/**
 * Regression tests for the app-blocker status-cache lost-update race
 * (#30142). `startAppBlock`/`stopAppBlock` must invalidate the 5s
 * `statusCache` AFTER the native `blockApps`/`unblockApps` mutation resolves,
 * not before. Clearing the cache only before awaiting the native call leaves a
 * window in which a concurrent status read (e.g. the app-blocker provider via
 * `getCachedAppBlockerStatus`) refetches the pre-mutation status and
 * repopulates the cache; because the mutation never re-invalidates once it
 * completes, callers keep serving the stale status for up to the TTL.
 *
 * The harness uses a real registered native backend (no source-under-test
 * mock): `getStatus()` reports the live `blocked` flag, and the mutation
 * methods block on a controllable gate before flipping the flag, so the test
 * deterministically drives a read into the native mutation window. The first
 * two cases fail on the pre-fix engine and pass once invalidation moves after
 * the write, mirroring the website-blocker engine's post-write
 * `resetSelfControlStatusCache()`.
 *
 * The third case covers the tighter interleaving raised in review: a read that
 * captures the pre-mutation native status but whose `getStatus()` only resolves
 * *after* the mutation's `finally` cleared the cache. Post-write invalidation
 * alone does not stop that late read from repopulating the cache with the stale
 * value; the engine's generation guard does, and this test proves it by gating
 * the read (not the mutation).
 *
 * The fourth case pins the TTL base to request start rather than native-call
 * resolution. Anchoring `expiresAt` to `Date.now()` after the await would let a
 * slow native `getStatus()` extend worst-case staleness by its own duration; a
 * fake-timer clock whose native read spans part of the TTL proves the entry
 * expires at request-start + TTL, so the next read after that point refetches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCachedAppBlockerStatus,
  type NativeAppBlockerBackend,
  registerNativeAppBlockerBackend,
  resetAppBlockerStatusCache,
  startAppBlock,
  stopAppBlock,
} from "./engine.ts";
import type {
  AppBlockerPermissionResult,
  AppBlockerStatus,
  BlockAppsResult,
  SelectAppsResult,
  UnblockAppsResult,
} from "./types.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function statusFor(blocked: boolean): AppBlockerStatus {
  return {
    available: true,
    active: blocked,
    platform: "ios",
    engine: "family-controls",
    blockedCount: blocked ? 1 : 0,
    blockedPackageNames: blocked ? ["com.example.app"] : [],
    endsAt: null,
    permissionStatus: "granted",
  };
}

/**
 * A native backend whose mutation methods await a caller-controlled gate before
 * flipping the block flag, so the test can hold the native window open and slip
 * a status read in between.
 */
function makeGatedBackend(initialBlocked: boolean): {
  backend: NativeAppBlockerBackend;
  releaseBlock: () => void;
  releaseUnblock: () => void;
} {
  let blocked = initialBlocked;
  const blockGate = deferred();
  const unblockGate = deferred();
  const permission: AppBlockerPermissionResult = {
    status: "granted",
    canRequest: false,
  };

  const backend: NativeAppBlockerBackend = {
    checkPermissions: async () => permission,
    requestPermissions: async () => permission,
    getInstalledApps: async () => ({ apps: [] }),
    selectApps: async () =>
      ({ apps: [], cancelled: false }) as SelectAppsResult,
    blockApps: async () => {
      await blockGate.promise;
      blocked = true;
      return {
        success: true,
        endsAt: null,
        blockedCount: 1,
      } satisfies BlockAppsResult;
    },
    unblockApps: async () => {
      await unblockGate.promise;
      blocked = false;
      return { success: true } satisfies UnblockAppsResult;
    },
    getStatus: async () => statusFor(blocked),
  };

  return {
    backend,
    releaseBlock: blockGate.resolve,
    releaseUnblock: unblockGate.resolve,
  };
}

/**
 * A native backend whose mutations apply immediately, but whose *first*
 * `getStatus()` snapshots the current block flag and then parks on a gate. This
 * lets the test start a read that captured the pre-mutation status and force it
 * to resolve after a full mutation has completed and invalidated the cache.
 */
function makeReadGatedBackend(initialBlocked: boolean): {
  backend: NativeAppBlockerBackend;
  releaseFirstRead: () => void;
} {
  let blocked = initialBlocked;
  let firstReadStarted = false;
  const firstReadGate = deferred();
  const permission: AppBlockerPermissionResult = {
    status: "granted",
    canRequest: false,
  };

  const backend: NativeAppBlockerBackend = {
    checkPermissions: async () => permission,
    requestPermissions: async () => permission,
    getInstalledApps: async () => ({ apps: [] }),
    selectApps: async () =>
      ({ apps: [], cancelled: false }) as SelectAppsResult,
    blockApps: async () => {
      blocked = true;
      return {
        success: true,
        endsAt: null,
        blockedCount: 1,
      } satisfies BlockAppsResult;
    },
    unblockApps: async () => {
      blocked = false;
      return { success: true } satisfies UnblockAppsResult;
    },
    getStatus: async () => {
      if (!firstReadStarted) {
        firstReadStarted = true;
        const snapshot = blocked;
        await firstReadGate.promise;
        return statusFor(snapshot);
      }
      return statusFor(blocked);
    },
  };

  return { backend, releaseFirstRead: firstReadGate.resolve };
}

describe("app-blocker status cache invalidation race (#30142)", () => {
  beforeEach(() => {
    // The status cache is module-level; clear leftover state so each case
    // exercises a real cache miss instead of a prior test's cached value.
    resetAppBlockerStatusCache();
  });

  afterEach(() => {
    registerNativeAppBlockerBackend(null as unknown as NativeAppBlockerBackend);
    resetAppBlockerStatusCache();
  });

  it("serves the applied block after startAppBlock even when a read hits the native window", async () => {
    const { backend, releaseBlock } = makeGatedBackend(false);
    registerNativeAppBlockerBackend(backend);

    // (1) Kick off the native block without awaiting it.
    const blockCompletion = startAppBlock({
      packageNames: ["com.example.app"],
    });

    // (2) A concurrent read lands inside the native mutation window: it sees the
    // still-unblocked native status and caches it.
    const duringWindow = await getCachedAppBlockerStatus();
    expect(duringWindow.active).toBe(false);

    // (3) Let the native block complete and await the mutation.
    releaseBlock();
    await blockCompletion;

    // (4) The next read must reflect the applied block, not the cached
    // pre-block status. This fails pre-fix because the cache was cleared before
    // the write and never re-invalidated afterward.
    const afterBlock = await getCachedAppBlockerStatus();
    expect(afterBlock.active).toBe(true);
    expect(afterBlock.blockedCount).toBe(1);
  });

  it("stops serving the stale block after stopAppBlock even when a read hits the native window", async () => {
    const { backend, releaseUnblock } = makeGatedBackend(true);
    registerNativeAppBlockerBackend(backend);

    // (1) Kick off the native unblock without awaiting it.
    const unblockCompletion = stopAppBlock();

    // (2) A concurrent read lands inside the native mutation window: the block
    // is still active, so it caches "blocking: true".
    const duringWindow = await getCachedAppBlockerStatus();
    expect(duringWindow.active).toBe(true);

    // (3) Let the native unblock complete and await the mutation.
    releaseUnblock();
    await unblockCompletion;

    // (4) The next read must reflect the removed block. Pre-fix the cache still
    // serves the stale "blocking: true" for the remaining TTL.
    const afterUnblock = await getCachedAppBlockerStatus();
    expect(afterUnblock.active).toBe(false);
    expect(afterUnblock.blockedCount).toBe(0);
  });

  it("does not repopulate the cache with a pre-mutation read that resolves after the mutation clears it", async () => {
    const { backend, releaseFirstRead } = makeReadGatedBackend(false);
    registerNativeAppBlockerBackend(backend);

    // (1) A status read starts and snapshots the pre-mutation (unblocked)
    // status, but its native getStatus() stays parked on the gate.
    const staleRead = getCachedAppBlockerStatus();
    // Yield so the read reaches its awaited getStatus() before the mutation.
    await Promise.resolve();

    // (2) A full block mutation completes while that read is parked. Its
    // `finally` invalidates the cache and bumps the generation.
    await startAppBlock({ packageNames: ["com.example.app"] });

    // (3) The parked read now resolves. Pre-fix it writes the pre-mutation
    // status into the cache *after* the invalidation; the racing caller still
    // sees its own in-flight (stale) value, which is expected.
    releaseFirstRead();
    expect((await staleRead).active).toBe(false);

    // (4) The shared cache must not have been poisoned: a subsequent read
    // reflects the applied block instead of serving the stale pre-mutation
    // status for the rest of the TTL.
    const afterBlock = await getCachedAppBlockerStatus();
    expect(afterBlock.active).toBe(true);
    expect(afterBlock.blockedCount).toBe(1);
  });

  it("anchors the status-cache TTL to request start, not native-call resolution", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);

      let getStatusCalls = 0;
      const firstReadGate = deferred();
      const permission: AppBlockerPermissionResult = {
        status: "granted",
        canRequest: false,
      };
      const backend: NativeAppBlockerBackend = {
        checkPermissions: async () => permission,
        requestPermissions: async () => permission,
        getInstalledApps: async () => ({ apps: [] }),
        selectApps: async () =>
          ({ apps: [], cancelled: false }) as SelectAppsResult,
        blockApps: async () =>
          ({
            success: true,
            endsAt: null,
            blockedCount: 1,
          }) satisfies BlockAppsResult,
        unblockApps: async () =>
          ({ success: true }) satisfies UnblockAppsResult,
        getStatus: async () => {
          getStatusCalls += 1;
          // Park only the first read so its native call visibly spans clock
          // time while the test advances the fake timer past resolution.
          if (getStatusCalls === 1) {
            await firstReadGate.promise;
          }
          return statusFor(false);
        },
      };
      registerNativeAppBlockerBackend(backend);

      // (1) The first read starts at t=0 and parks inside the native getStatus().
      const firstRead = getCachedAppBlockerStatus();

      // (2) The native call "takes" 4s (< the 5s TTL): advance the clock so its
      // resolution timestamp (4000) differs from the request start (0), then
      // release it. The published entry must expire at request-start + TTL.
      vi.setSystemTime(4_000);
      firstReadGate.resolve();
      await firstRead;
      expect(getStatusCalls).toBe(1);

      // (3) At t=6000 a request-start-anchored entry (expires at 0 + 5000) has
      // expired, so the next read must refetch. A resolution-anchored entry
      // (expires at 4000 + 5000 = 9000) would still be live and skip the native
      // call, extending worst-case staleness by the native-call duration.
      vi.setSystemTime(6_000);
      await getCachedAppBlockerStatus();
      expect(getStatusCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
