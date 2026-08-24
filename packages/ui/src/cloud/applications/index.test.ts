/**
 * Verifies the Applications cloud-domain barrel against the real cloud-route
 * registry: both surfaces are wired at import time under the exported path
 * constants, the import-time side effect leaves the legacy `cloud/applications`
 * paths to the moved-route handoff, re-registration preserves element identity
 * while moving the entries later in registration order, subscribers hear
 * exactly the registrations until they unsubscribe, and both route elements are
 * code-split React.lazy components. Runs through the package's configured
 * harness (jsdom) against the live `Symbol.for`-keyed registry store — no
 * module mocks.
 */
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  getCloudRoute,
  getCloudRouteRegistryVersion,
  listCloudRoutes,
  registerCloudRoute,
  subscribeCloudRoutes,
} from "../shell/cloud-route-registry";
import {
  APPLICATIONS_DETAIL_ROUTE_PATH,
  APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH,
  APPLICATIONS_LEGACY_LIST_ROUTE_PATH,
  APPLICATIONS_LIST_ROUTE_PATH,
  applicationsDetailCloudRoute,
  applicationsListCloudRoute,
  registerApplicationsCloudRoutes,
} from "./index";

function registrationOrder(path: string): number {
  const index = listCloudRoutes().findIndex((route) => route.path === path);
  expect(index, `route ${path} should be registered`).toBeGreaterThanOrEqual(0);
  return index;
}

function ProbeRoute() {
  return null;
}

describe("applications cloud barrel — import-time registration", () => {
  it("resolves the canonical list URL to the registered list route", () => {
    // Looked up by the literal slug a link/router would use, then tied back to
    // the exported constant, so the constant and the live registration cannot
    // drift apart silently.
    expect(getCloudRoute("cloud/apps")?.path).toBe(
      APPLICATIONS_LIST_ROUTE_PATH,
    );
    expect(getCloudRoute(APPLICATIONS_LIST_ROUTE_PATH)).toMatchObject({
      group: "cloud",
      element: applicationsListCloudRoute.element,
    });
  });

  it("resolves the canonical detail URL to the registered detail route", () => {
    expect(getCloudRoute("cloud/apps/:id")?.path).toBe(
      APPLICATIONS_DETAIL_ROUTE_PATH,
    );
    expect(getCloudRoute(APPLICATIONS_DETAIL_ROUTE_PATH)).toMatchObject({
      group: "cloud",
      element: applicationsDetailCloudRoute.element,
    });
  });

  it("leaves the legacy cloud/applications paths unregistered", () => {
    // The legacy spellings belong to registerMovedApplicationsCloudRoutes
    // (retired-Apps redirect); importing the barrel alone must not claim them.
    expect(getCloudRoute(APPLICATIONS_LEGACY_LIST_ROUTE_PATH)).toBeUndefined();
    expect(
      getCloudRoute(APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH),
    ).toBeUndefined();
  });
});

describe("registerApplicationsCloudRoutes — re-registration semantics", () => {
  it("re-registration replaces both entries and lands them after previously-later routes", () => {
    // A route any other cloud domain registers after ours starts later in the
    // shell's registration order; re-registering Applications must move both
    // of its routes past that route — the documented last-write-wins store.
    const probePath = "applications-index-test/probe";
    registerCloudRoute({ path: probePath, element: ProbeRoute });
    expect(registrationOrder(APPLICATIONS_LIST_ROUTE_PATH)).toBeLessThan(
      registrationOrder(probePath),
    );
    expect(registrationOrder(APPLICATIONS_DETAIL_ROUTE_PATH)).toBeLessThan(
      registrationOrder(probePath),
    );

    registerApplicationsCloudRoutes();

    expect(registrationOrder(APPLICATIONS_LIST_ROUTE_PATH)).toBeGreaterThan(
      registrationOrder(probePath),
    );
    expect(registrationOrder(APPLICATIONS_DETAIL_ROUTE_PATH)).toBeGreaterThan(
      registrationOrder(probePath),
    );
    // Re-registration passes the same exported defs, so the registry entry a
    // consumer reads keeps pointing at the original lazy element — it was
    // replaced, not rebuilt as a second component.
    expect(getCloudRoute(APPLICATIONS_LIST_ROUTE_PATH)?.element).toBe(
      applicationsListCloudRoute.element,
    );
    expect(getCloudRoute(APPLICATIONS_DETAIL_ROUTE_PATH)?.element).toBe(
      applicationsDetailCloudRoute.element,
    );
    expect(getCloudRoute(APPLICATIONS_DETAIL_ROUTE_PATH)).toMatchObject({
      group: "cloud",
    });
  });

  it("bumps the registry snapshot version once per registration", () => {
    const before = getCloudRouteRegistryVersion();
    registerApplicationsCloudRoutes();
    expect(getCloudRouteRegistryVersion() - before).toBe(2);
  });

  it("notifies subscribers per registration and stops after unsubscribe", () => {
    let notifications = 0;
    const unsubscribe = subscribeCloudRoutes(() => {
      notifications += 1;
    });

    registerApplicationsCloudRoutes();
    expect(notifications).toBe(2);

    unsubscribe();
    registerApplicationsCloudRoutes();
    expect(notifications).toBe(2);
  });
});

describe("applications route elements — code splitting contract", () => {
  it("mounts both surfaces as distinct React.lazy elements", () => {
    const listElement = applicationsListCloudRoute.element as {
      $$typeof?: unknown;
    };
    const detailElement = applicationsDetailCloudRoute.element as {
      $$typeof?: unknown;
    };
    expect(listElement.$$typeof).toBe(Symbol.for("react.lazy"));
    expect(detailElement.$$typeof).toBe(Symbol.for("react.lazy"));
    expect(applicationsListCloudRoute.element).not.toBe(
      applicationsDetailCloudRoute.element,
    );
  });
});
