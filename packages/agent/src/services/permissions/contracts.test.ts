/**
 * Pins the local permission-registry re-export to `@elizaos/shared` and
 * drives the real PermissionRegistry through that IPermissionsRegistry:
 * empty list, missing-id get, single-element check, insertion-order list,
 * pending filter, subscribe/unsubscribe, optional openSettings, and
 * check/request without a prober. The ESM module is type-only, so it has
 * no runtime exports.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
  isPermissionId,
  PERMISSION_IDS,
  type Platform,
  type IPermissionsRegistry as SharedIPermissionsRegistry,
  type PermissionId as SharedPermissionId,
  type PermissionRestrictedReason as SharedPermissionRestrictedReason,
  type PermissionState as SharedPermissionState,
  type PermissionStatus as SharedPermissionStatus,
  type Prober as SharedProber,
} from "@elizaos/shared";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";

import { PermissionRegistry } from "../permissions-registry.ts";
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionPlatform,
  PermissionRestrictedReason,
  PermissionState,
  PermissionStatus,
  Prober,
} from "./contracts.ts";

const PERMISSION_STATUSES: readonly PermissionStatus[] = [
  "granted",
  "limited",
  "denied",
  "not-determined",
  "restricted",
  "not-applicable",
];

const RESTRICTED_REASONS: readonly PermissionRestrictedReason[] = [
  "entitlement_required",
  "platform_unsupported",
  "os_policy",
];

const PERMISSION_PLATFORMS: readonly PermissionPlatform[] = [
  "darwin",
  "win32",
  "linux",
  "ios",
  "android",
  "web",
];

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000000",
    character: { name: "contracts-coverage" },
  } as IAgentRuntime;
}

class MemoryPersistence {
  data: PermissionState[] | null = null;

  read(): PermissionState[] | null {
    return this.data;
  }

  write(states: PermissionState[]): void {
    this.data = states.map((state) => ({ ...state }));
  }
}

function makeProber(
  id: PermissionId,
  status: PermissionStatus = "not-determined",
  openSettings?: () => Promise<boolean>,
): Prober {
  const platform: PermissionPlatform = "darwin";
  const state: PermissionState = {
    id,
    status,
    canRequest: status !== "restricted" && status !== "not-applicable",
    lastChecked: Date.now(),
    platform,
  };
  const prober: Prober = {
    id,
    check: async () => ({ ...state }),
    request: async () => ({
      ...state,
      status: "granted",
      canRequest: false,
      lastChecked: Date.now(),
    }),
  };
  if (openSettings) {
    prober.openSettings = openSettings;
  }
  return prober;
}

function makeRegistry(): IPermissionsRegistry {
  return new PermissionRegistry(makeRuntime(), {
    persistence: new MemoryPersistence(),
    persistDebounceMs: 0,
  });
}

describe("permissions contracts re-export", () => {
  it("re-exports the shared permission-registry types without widening", () => {
    expectTypeOf<PermissionId>().toEqualTypeOf<SharedPermissionId>();
    expectTypeOf<PermissionId>().toEqualTypeOf<
      (typeof PERMISSION_IDS)[number]
    >();
    expectTypeOf<PermissionStatus>().toEqualTypeOf<SharedPermissionStatus>();
    expectTypeOf<PermissionStatus>().toEqualTypeOf<
      (typeof PERMISSION_STATUSES)[number]
    >();
    expectTypeOf<PermissionRestrictedReason>().toEqualTypeOf<SharedPermissionRestrictedReason>();
    expectTypeOf<PermissionRestrictedReason>().toEqualTypeOf<
      (typeof RESTRICTED_REASONS)[number]
    >();
    expectTypeOf<PermissionState>().toEqualTypeOf<SharedPermissionState>();
    expectTypeOf<Prober>().toEqualTypeOf<SharedProber>();
    expectTypeOf<IPermissionsRegistry>().toEqualTypeOf<SharedIPermissionsRegistry>();
    expectTypeOf<PermissionPlatform>().toEqualTypeOf<Platform>();
    expectTypeOf<PermissionPlatform>().toEqualTypeOf<
      (typeof PERMISSION_PLATFORMS)[number]
    >();
  });

  it("is a type-only module with no runtime exports", async () => {
    const mod = await import("./contracts.ts");
    expect(Object.keys(mod)).toEqual([]);
  });

  it("accepts every canonical PermissionId and rejects values outside the union", () => {
    expect(PERMISSION_IDS.length).toBeGreaterThan(0);
    for (const id of PERMISSION_IDS) {
      expect(isPermissionId(id)).toBe(true);
      const typed: PermissionId = id;
      expect(typed).toBe(id);
    }
    expect(isPermissionId("")).toBe(false);
    expect(isPermissionId("not-a-permission")).toBe(false);
    expect(isPermissionId("CAMERA")).toBe(false);
    expect(isPermissionId(null)).toBe(false);
    expect(isPermissionId(undefined)).toBe(false);
    expect(isPermissionId(1)).toBe(false);
  });

  it("requires id, status, lastChecked, canRequest, and platform on PermissionState", () => {
    const restricted: PermissionState = {
      id: "accessibility",
      status: "restricted",
      restrictedReason: "entitlement_required",
      lastChecked: 1,
      lastRequested: 2,
      lastBlockedFeature: { app: "lifeops", action: "remind", at: 3 },
      canRequest: false,
      platform: "darwin",
      reason: "missing entitlement",
    };
    expect(restricted.id).toBe("accessibility");
    expect(restricted.status).toBe("restricted");
    expect(restricted.restrictedReason).toBe("entitlement_required");
    expect(restricted.lastChecked).toBe(1);
    expect(restricted.lastRequested).toBe(2);
    expect(restricted.lastBlockedFeature).toEqual({
      app: "lifeops",
      action: "remind",
      at: 3,
    });
    expect(restricted.canRequest).toBe(false);
    expect(restricted.platform).toBe("darwin");
    expect(restricted.reason).toBe("missing entitlement");

    const minimal: PermissionState = {
      id: "camera",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
      platform: "web",
    };
    expect(minimal.restrictedReason).toBeUndefined();
    expect(minimal.lastRequested).toBeUndefined();
    expect(minimal.lastBlockedFeature).toBeUndefined();
    expect(minimal.reason).toBeUndefined();
  });
});

describe("IPermissionsRegistry via PermissionRegistry", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "perm-contracts-"));
    process.env.ELIZA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ELIZA_STATE_DIR;
  });

  it("starts with an empty list and a default state for a missing id", () => {
    const registry = makeRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.pending()).toEqual([]);

    const missing = registry.get("camera");
    expect(missing.id).toBe("camera");
    expect(missing.status).toBe("not-determined");
    expect(missing.canRequest).toBe(true);
    expect(["darwin", "win32", "linux"]).toContain(missing.platform);
    // get() does not insert a missing id into the live list.
    expect(registry.list()).toEqual([]);
  });

  it("throws when check() or request() runs without a registered prober", async () => {
    const registry = makeRegistry();
    await expect(registry.check("calendar")).rejects.toThrow(
      /no prober registered for calendar/,
    );
    await expect(
      registry.request("calendar", {
        reason: "need calendar",
        feature: { app: "lifeops", action: "list" },
      }),
    ).rejects.toThrow(/no prober registered for calendar/);
  });

  it("registers a prober and stores a single checked state", async () => {
    const registry = makeRegistry();
    registry.registerProber(makeProber("microphone", "denied"));

    const result = await registry.check("microphone");
    expect(result.id).toBe("microphone");
    expect(result.status).toBe("denied");
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("microphone").status).toBe("denied");
    expect(registry.list()[0]?.id).toBe("microphone");
  });

  it("keeps list() in insertion order for two distinct ids", async () => {
    const registry = makeRegistry();
    registry.registerProber(makeProber("notes", "granted"));
    registry.registerProber(makeProber("contacts", "denied"));

    await registry.check("notes");
    await registry.check("contacts");

    expect(registry.list().map((state) => state.id)).toEqual([
      "notes",
      "contacts",
    ]);
  });

  it("request() stamps lastRequested and lastBlockedFeature from the feature ref", async () => {
    const registry = makeRegistry();
    registry.registerProber(makeProber("contacts"));

    const before = Date.now();
    const result = await registry.request("contacts", {
      reason: "Need access",
      feature: { app: "address-book", action: "list" },
    });

    expect(result.status).toBe("granted");
    expect(result.lastRequested).toBeGreaterThanOrEqual(before);
    expect(result.lastBlockedFeature).toMatchObject({
      app: "address-book",
      action: "list",
    });
    expect(result.lastBlockedFeature?.at).toBeGreaterThanOrEqual(before);
  });

  it("returns false from openSettings() when the prober omits the hook", async () => {
    const registry = makeRegistry();
    registry.registerProber(makeProber("camera"));

    await expect(registry.openSettings("camera")).resolves.toBe(false);
    await expect(registry.openSettings("microphone")).resolves.toBe(false);
  });

  it("delegates openSettings() when the prober provides the optional hook", async () => {
    const registry = makeRegistry();
    let opened = 0;
    registry.registerProber(
      makeProber("location", "not-determined", async () => {
        opened += 1;
        return true;
      }),
    );

    await expect(registry.openSettings("location")).resolves.toBe(true);
    expect(opened).toBe(1);
  });

  it("recordBlock() inserts a missing id rather than throwing", () => {
    const registry = makeRegistry();
    registry.recordBlock("notifications", {
      app: "lifeops",
      action: "remind",
    });

    const state = registry.get("notifications");
    expect(state.id).toBe("notifications");
    expect(state.status).toBe("not-determined");
    expect(state.lastBlockedFeature).toMatchObject({
      app: "lifeops",
      action: "remind",
    });
    expect(registry.list()).toHaveLength(1);
  });

  it("pending() includes not-determined and recently blocked states, not granted", async () => {
    const registry = makeRegistry();
    registry.registerProber(makeProber("camera", "granted"));
    registry.registerProber(makeProber("microphone", "not-determined"));

    await registry.check("camera");
    await registry.check("microphone");
    registry.recordBlock("notifications", { app: "x", action: "y" });

    const ids = registry.pending().map((state) => state.id);
    expect(ids).toContain("microphone");
    expect(ids).toContain("notifications");
    expect(ids).not.toContain("camera");
  });

  it("notifies subscribers on mutation and supports unsubscribe", () => {
    const registry = makeRegistry();
    const seen: number[] = [];
    const unsubscribe = registry.subscribe((states) => {
      seen.push(states.length);
    });

    registry.recordBlock("calendar", { app: "a", action: "b" });
    expect(seen).toEqual([1]);

    unsubscribe();
    registry.recordBlock("reminders", { app: "a", action: "b" });
    expect(seen).toEqual([1]);
  });
});
