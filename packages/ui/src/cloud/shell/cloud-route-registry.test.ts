/**
 * Unit coverage for the cloud route registry (register/get, public-access map).
 * In-memory registry, no runtime.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_PUBLIC_ROUTE_ACCESS,
  getCloudRoute,
  listCloudRoutes,
  registerCloudRoute,
} from "./cloud-route-registry";

function TestRoute() {
  return null;
}

describe("cloud route public registration policy", () => {
  it("preserves semantic surface layout through get and list projections", () => {
    registerCloudRoute({
      path: "layout/workspace",
      element: TestRoute,
      surface: {
        header: "fullscreen",
        layout: { kind: "workspace", width: "wide", scroll: "view" },
      },
    });

    const expected = {
      header: "fullscreen",
      layout: { kind: "workspace", width: "wide", scroll: "view" },
    };
    expect(getCloudRoute("layout/workspace")?.surface).toEqual(expected);
    expect(
      listCloudRoutes().find((route) => route.path === "layout/workspace")
        ?.surface,
    ).toEqual(expected);
  });

  it("rejects ambient topology for managed child routes", () => {
    expect(() =>
      registerCloudRoute({
        path: "cloud/ambient-child",
        group: "cloud",
        element: TestRoute,
        surface: {
          layout: {
            kind: "immersive",
            topology: "ambient",
            width: "full",
            scroll: "view",
            gutter: "none",
          },
        },
      }),
    ).toThrow(/canonical framed topology/);
    expect(getCloudRoute("cloud/ambient-child")).toBeUndefined();
  });

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
