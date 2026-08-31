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
 * deterministically drives a read into the native mutation window. Both cases
 * fail on the pre-fix engine and pass once invalidation moves after the write,
 * mirroring the website-blocker engine's post-write
 * `resetSelfControlStatusCache()`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  getCachedAppBlockerStatus,
  type NativeAppBlockerBackend,
  registerNativeAppBlockerBackend,
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

describe("app-blocker status cache invalidation race (#30142)", () => {
  afterEach(() => {
    registerNativeAppBlockerBackend(null as unknown as NativeAppBlockerBackend);
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
});
