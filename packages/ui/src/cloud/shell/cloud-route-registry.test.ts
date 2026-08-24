/**
 * Unit coverage for the cloud route registry (register/get, public-access map).
 * In-memory registry, no runtime.
 * Snapshot/reset/restore cases exercise the observable mutation contract.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_PUBLIC_ROUTE_ACCESS,
  getCloudRoute,
  getCloudRouteRegistryVersion,
  listCloudRoutes,
  registerCloudRoute,
  resetCloudRouteRegistry,
  restoreCloudRouteRegistry,
  snapshotCloudRouteRegistry,
  subscribeCloudRoutes,
} from "./cloud-route-registry";

function TestRoute() {
  return null;
}

describe("cloud route public registration policy", () => {
  it("rejects public routes without explicit reviewed-public opt-in", () => {
    expect(() =>
      registerCloudRoute({
        path: "security/public-without-token",
        element: TestRoute,
        public: true,
      }),
    ).toThrow(/CLOUD_PUBLIC_ROUTE_ACCESS/);
    expect(getCloudRoute("security/public-without-token")).toBeUndefined();
  });

  it("allows public routes with explicit reviewed-public opt-in", () => {
    registerCloudRoute({
      path: "security/public-with-token",
      element: TestRoute,
      public: true,
      publicAccess: CLOUD_PUBLIC_ROUTE_ACCESS,
    });

    expect(getCloudRoute("security/public-with-token")).toMatchObject({
      public: true,
      publicAccess: CLOUD_PUBLIC_ROUTE_ACCESS,
    });
  });

  it("warns in dev/test when re-registration flips a private route public", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerCloudRoute({
      path: "security/private-then-public",
      element: TestRoute,
    });
    registerCloudRoute({
      path: "security/private-then-public",
      element: TestRoute,
      public: true,
      publicAccess: CLOUD_PUBLIC_ROUTE_ACCESS,
    });

    expect(warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("cloud-routes.private-to-public-reregistration"),
    );
  });
});

describe("cloud route registry lifecycle", () => {
  it("reset notifies once and advances the registry version monotonically", () => {
    const snapshot = snapshotCloudRouteRegistry();
    let notifications = 0;
    const unsubscribe = subscribeCloudRoutes(() => {
      notifications += 1;
    });
    const versionBeforeReset = getCloudRouteRegistryVersion();

    try {
      resetCloudRouteRegistry();
      expect(listCloudRoutes()).toEqual([]);
      expect(notifications).toBe(1);
      expect(getCloudRouteRegistryVersion()).toBeGreaterThan(
        versionBeforeReset,
      );
    } finally {
      unsubscribe();
      restoreCloudRouteRegistry(snapshot);
    }
  });

  it("restore notifies once, advances the version, and replaces current entries", () => {
    const snapshot = snapshotCloudRouteRegistry();
    registerCloudRoute({
      path: "lifecycle/added-after-snapshot",
      element: TestRoute,
    });
    let notifications = 0;
    const unsubscribe = subscribeCloudRoutes(() => {
      notifications += 1;
    });
    const versionBeforeRestore = getCloudRouteRegistryVersion();

    try {
      restoreCloudRouteRegistry(snapshot);
      expect(getCloudRoute("lifecycle/added-after-snapshot")).toBeUndefined();
      expect(snapshotCloudRouteRegistry()).toEqual(snapshot);
      expect(notifications).toBe(1);
      expect(getCloudRouteRegistryVersion()).toBeGreaterThan(
        versionBeforeRestore,
      );
    } finally {
      unsubscribe();
      restoreCloudRouteRegistry(snapshot);
    }
  });

  it("rejects an invalid snapshot atomically without notifying or advancing", () => {
    const snapshot = snapshotCloudRouteRegistry();
    const versionBeforeRestore = getCloudRouteRegistryVersion();
    let notifications = 0;
    const unsubscribe = subscribeCloudRoutes(() => {
      notifications += 1;
    });

    try {
      expect(() =>
        restoreCloudRouteRegistry({
          routes: [
            ...snapshot.routes,
            {
              path: "lifecycle/unreviewed-public",
              element: TestRoute,
              public: true,
            },
          ],
        }),
      ).toThrow(/CLOUD_PUBLIC_ROUTE_ACCESS/);
      expect(snapshotCloudRouteRegistry()).toEqual(snapshot);
      expect(getCloudRouteRegistryVersion()).toBe(versionBeforeRestore);
      expect(notifications).toBe(0);
    } finally {
      unsubscribe();
      restoreCloudRouteRegistry(snapshot);
    }
  });
});
