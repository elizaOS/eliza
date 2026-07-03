import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_PUBLIC_ROUTE_ACCESS,
  getCloudRoute,
  registerCloudRoute,
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
      expect.stringContaining("re-registered from private to public"),
    );
  });
});
