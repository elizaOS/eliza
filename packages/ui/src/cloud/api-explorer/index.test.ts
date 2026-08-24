/**
 * Unit coverage for the api-explorer cloud-domain barrel: the stable
 * section/route ids, its import-time registration into the shared cloud-route
 * registry consumed by CloudRouterShell, override re-registration semantics,
 * and the fail-closed public-access policy. Drives the real registry and real
 * sibling modules — no mocks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_PUBLIC_ROUTE_ACCESS,
  getCloudRoute,
  getCloudRouteRegistryVersion,
  subscribeCloudRoutes,
} from "../shell/cloud-route-registry";
import {
  API_EXPLORER_ROUTE_PATH,
  API_EXPLORER_SECTION_ID,
  ApiExplorerRoute,
  ApiExplorerSurface,
  ApiTester,
  AuthManager,
  apiExplorerCloudRoute,
  registerApiExplorerCloudRoute,
  useExplorerApiKey,
} from "./index";

afterEach(() => {
  // Restore the canonical import-time registration after override cases.
  registerApiExplorerCloudRoute();
});

describe("api-explorer cloud domain ids", () => {
  it("publishes stable section and route path ids", () => {
    expect(API_EXPLORER_SECTION_ID).toBe("api-explorer");
    expect(API_EXPLORER_ROUTE_PATH).toBe("cloud/api-explorer");
  });
});

describe("api-explorer cloud route registration", () => {
  it("registers the standalone surface at import time as a private cloud-group route", () => {
    const registered = getCloudRoute(API_EXPLORER_ROUTE_PATH);

    expect(registered?.path).toBe(API_EXPLORER_ROUTE_PATH);
    expect(registered?.group).toBe("cloud");
    expect(registered?.public ?? false).toBe(false);
    expect(registered?.gate).toBeUndefined();
    expect(registered?.element).toBeTruthy();
    // The registry stores a spread copy of the definition, so the element the
    // shell will render is the exact lazy element this module publishes.
    expect(registered?.element).toBe(apiExplorerCloudRoute.element);
  });

  it("re-registration merges overrides over the published route and notifies shell subscribers", () => {
    const notified = vi.fn();
    const unsubscribe = subscribeCloudRoutes(notified);
    const versionBefore = getCloudRouteRegistryVersion();

    try {
      registerApiExplorerCloudRoute({ gate: "admin" });

      const updated = getCloudRoute(API_EXPLORER_ROUTE_PATH);
      expect(updated?.gate).toBe("admin");
      // Fields absent from the override survive the merge unchanged.
      expect(updated?.path).toBe(API_EXPLORER_ROUTE_PATH);
      expect(updated?.group).toBe("cloud");
      expect(updated?.element).toBe(apiExplorerCloudRoute.element);
      expect(getCloudRouteRegistryVersion()).toBeGreaterThan(versionBefore);
      expect(notified).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("refuses to flip the explorer route public without reviewed opt-in and leaves it private", () => {
    const versionBefore = getCloudRouteRegistryVersion();

    expect(() => registerApiExplorerCloudRoute({ public: true })).toThrow(
      /CLOUD_PUBLIC_ROUTE_ACCESS/,
    );

    // The rejection happens before any mutation: same element, still private,
    // and the shell-visible version never advanced.
    const intact = getCloudRoute(API_EXPLORER_ROUTE_PATH);
    expect(intact?.public ?? false).toBe(false);
    expect(intact?.element).toBe(apiExplorerCloudRoute.element);
    expect(getCloudRouteRegistryVersion()).toBe(versionBefore);
  });

  it("accepts a reviewed public override carrying CLOUD_PUBLIC_ROUTE_ACCESS", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      registerApiExplorerCloudRoute({
        public: true,
        publicAccess: CLOUD_PUBLIC_ROUTE_ACCESS,
      });

      const flipped = getCloudRoute(API_EXPLORER_ROUTE_PATH);
      expect(flipped?.public).toBe(true);
      expect(flipped?.publicAccess).toBe(CLOUD_PUBLIC_ROUTE_ACCESS);
      // Flipping a previously private route is loud in dev/test.
      expect(warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining(
          "cloud-routes.private-to-public-reregistration",
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("api-explorer runtime exports", () => {
  it("re-exports the surfaces and hook callers bind from the barrel", () => {
    expect(ApiExplorerSurface).toBeDefined();
    expect(ApiExplorerRoute).toBeDefined();
    expect(ApiTester).toBeDefined();
    expect(AuthManager).toBeDefined();
    expect(typeof useExplorerApiKey).toBe("function");
  });
});
