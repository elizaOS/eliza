/**
 * Verifies the Admin cloud-domain barrel against the real cloud-route
 * registries: all three admin surfaces are wired at import time under the
 * exported path constants, every route declares the `admin` gate AND that gate
 * resolves to the real `AdminGate` component (an unregistered gate renders a
 * fail-closed denial, so the pairing is load-bearing), no admin route is
 * public, re-registration preserves element identity while moving the entries
 * later in registration order, subscribers hear exactly the registrations
 * until they unsubscribe, and each route element is a distinct code-split
 * React.lazy component. Runs through the package's configured harness (jsdom)
 * against the live `Symbol.for`-keyed stores — no module mocks.
 */
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  getCloudRoute,
  getCloudRouteGate,
  getCloudRouteRegistryVersion,
  listCloudRoutes,
  registerCloudRoute,
  subscribeCloudRoutes,
} from "../shell/cloud-route-registry";
import { AdminGate } from "./AdminGate";
import {
  ADMIN_MODERATION_ROUTE_PATH,
  ADMIN_REDEMPTIONS_ROUTE_PATH,
  ADMIN_ROUTE_GATE,
  ADMIN_RPC_STATUS_ROUTE_PATH,
  adminModerationCloudRoute,
  adminRedemptionsCloudRoute,
  adminRpcStatusCloudRoute,
  registerAdminCloudRoutes,
} from "./index";

const ADMIN_ROUTE_PATHS = [
  ADMIN_MODERATION_ROUTE_PATH,
  ADMIN_REDEMPTIONS_ROUTE_PATH,
  ADMIN_RPC_STATUS_ROUTE_PATH,
] as const;

function registrationOrder(path: string): number {
  const index = listCloudRoutes().findIndex((route) => route.path === path);
  expect(index, `route ${path} should be registered`).toBeGreaterThanOrEqual(0);
  return index;
}

function ProbeRoute(): null {
  return null;
}

describe("admin cloud barrel — import-time registration", () => {
  it("resolves each admin URL to its registered route under the exported constants", () => {
    // Looked up by the literal slugs a link/router would use, then tied back
    // to the exported constants, so the constants and the live registrations
    // cannot drift apart silently.
    expect(getCloudRoute("cloud/admin")?.path).toBe(
      ADMIN_MODERATION_ROUTE_PATH,
    );
    expect(getCloudRoute("cloud/admin/redemptions")?.path).toBe(
      ADMIN_REDEMPTIONS_ROUTE_PATH,
    );
    expect(getCloudRoute("cloud/admin/rpc-status")?.path).toBe(
      ADMIN_RPC_STATUS_ROUTE_PATH,
    );
    expect(getCloudRoute(ADMIN_MODERATION_ROUTE_PATH)).toMatchObject({
      group: "admin",
      gate: ADMIN_ROUTE_GATE,
      element: adminModerationCloudRoute.element,
    });
    expect(getCloudRoute(ADMIN_REDEMPTIONS_ROUTE_PATH)).toMatchObject({
      group: "admin",
      gate: ADMIN_ROUTE_GATE,
      element: adminRedemptionsCloudRoute.element,
    });
    expect(getCloudRoute(ADMIN_RPC_STATUS_ROUTE_PATH)).toMatchObject({
      group: "admin",
      gate: ADMIN_ROUTE_GATE,
      element: adminRpcStatusCloudRoute.element,
    });
  });

  it("pairs every admin route with the admin gate that is actually registered", () => {
    // The shell wraps route bodies in the gate looked up BY NAME; a gate name
    // without a registered component renders a fail-closed denial instead of
    // the page, so the route→gate→component chain must be intact end to end.
    expect(ADMIN_ROUTE_GATE).toBe("admin");
    expect(getCloudRouteGate(ADMIN_ROUTE_GATE)).toBe(AdminGate);
    for (const path of ADMIN_ROUTE_PATHS) {
      const gateName = getCloudRoute(path)?.gate;
      expect(gateName, `route ${path} must declare a gate`).toBeTruthy();
      expect(getCloudRouteGate(gateName as string)).toBe(AdminGate);
    }
  });

  it("keeps every admin route private", () => {
    // Admin surfaces are role-gated business ops; none may opt into public
    // exposure, and none carries the public-access opt-in marker.
    for (const path of ADMIN_ROUTE_PATHS) {
      const route = getCloudRoute(path);
      expect(route, `route ${path} should be registered`).toBeDefined();
      expect(route?.public).not.toBe(true);
      expect(route?.publicAccess).toBeUndefined();
    }
  });
});

describe("registerAdminCloudRoutes — re-registration semantics", () => {
  it("re-registration replaces all three entries and lands them after previously-later routes", () => {
    // A route any other cloud domain registers after ours starts later in the
    // shell's registration order; re-registering Admin must move all three of
    // its routes past that route — the documented last-write-wins store.
    const probePath = "admin-index-test/probe";
    registerCloudRoute({ path: probePath, element: ProbeRoute });
    expect(registrationOrder(ADMIN_MODERATION_ROUTE_PATH)).toBeLessThan(
      registrationOrder(probePath),
    );
    expect(registrationOrder(ADMIN_REDEMPTIONS_ROUTE_PATH)).toBeLessThan(
      registrationOrder(probePath),
    );
    expect(registrationOrder(ADMIN_RPC_STATUS_ROUTE_PATH)).toBeLessThan(
      registrationOrder(probePath),
    );

    registerAdminCloudRoutes();

    expect(registrationOrder(ADMIN_MODERATION_ROUTE_PATH)).toBeGreaterThan(
      registrationOrder(probePath),
    );
    expect(registrationOrder(ADMIN_REDEMPTIONS_ROUTE_PATH)).toBeGreaterThan(
      registrationOrder(probePath),
    );
    expect(registrationOrder(ADMIN_RPC_STATUS_ROUTE_PATH)).toBeGreaterThan(
      registrationOrder(probePath),
    );
    // Registration passes the same exported defs, so the registry entries a
    // consumer reads keep pointing at the original lazy elements — replaced,
    // not rebuilt as second components.
    expect(getCloudRoute(ADMIN_MODERATION_ROUTE_PATH)?.element).toBe(
      adminModerationCloudRoute.element,
    );
    expect(getCloudRoute(ADMIN_REDEMPTIONS_ROUTE_PATH)?.element).toBe(
      adminRedemptionsCloudRoute.element,
    );
    expect(getCloudRoute(ADMIN_RPC_STATUS_ROUTE_PATH)?.element).toBe(
      adminRpcStatusCloudRoute.element,
    );
  });

  it("keeps the documented relative order of the three admin surfaces", () => {
    registerAdminCloudRoutes();
    expect(registrationOrder(ADMIN_MODERATION_ROUTE_PATH)).toBeLessThan(
      registrationOrder(ADMIN_REDEMPTIONS_ROUTE_PATH),
    );
    expect(registrationOrder(ADMIN_REDEMPTIONS_ROUTE_PATH)).toBeLessThan(
      registrationOrder(ADMIN_RPC_STATUS_ROUTE_PATH),
    );
  });

  it("bumps the registry snapshot version once per route registration", () => {
    const before = getCloudRouteRegistryVersion();
    registerAdminCloudRoutes();
    expect(getCloudRouteRegistryVersion() - before).toBe(3);
  });

  it("notifies subscribers per registration and stops after unsubscribe", () => {
    let notifications = 0;
    const unsubscribe = subscribeCloudRoutes(() => {
      notifications += 1;
    });

    registerAdminCloudRoutes();
    expect(notifications).toBe(3);

    unsubscribe();
    registerAdminCloudRoutes();
    expect(notifications).toBe(3);
  });
});

describe("admin route elements — code splitting contract", () => {
  it("mounts all three surfaces as distinct React.lazy elements", () => {
    const elements = [
      adminModerationCloudRoute.element,
      adminRedemptionsCloudRoute.element,
      adminRpcStatusCloudRoute.element,
    ] as Array<{ $$typeof?: unknown }>;
    for (const element of elements) {
      expect(element.$$typeof).toBe(Symbol.for("react.lazy"));
    }
    expect(elements[0]).not.toBe(elements[1]);
    expect(elements[1]).not.toBe(elements[2]);
    expect(elements[0]).not.toBe(elements[2]);
  });
});
