/**
 * Verifies the approvals domain barrel: pinned section/path constants, the
 * standalone route definition shape, the import-time self-registration into
 * the shared cloud-route registry, `registerApprovalsCloudRoute`'s
 * override-merge semantics against the real registry, and that every
 * hook/component re-export binds to the real implementation in
 * `./lib/approvals` and `./ApprovalsRoute`. Runs through the package's
 * configured test harness (jsdom, real modules, no mocks) and deliberately
 * does not touch `registerAllCloudSurfaces`, which `register.test.ts` already
 * covers.
 */
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  getCloudRoute,
  listCloudRoutes,
  subscribeCloudRoutes,
} from "../shell/cloud-route-registry";
import * as approvalsRouteModule from "./ApprovalsRoute";
import * as approvalsBarrel from "./index";
import {
  APPROVALS_ROUTE_PATH,
  APPROVALS_SECTION_ID,
  approvalsCloudRoute,
  registerApprovalsCloudRoute,
} from "./index";
import * as approvalsDataLayer from "./lib/approvals";

describe("approvals barrel constants", () => {
  it("pins the stable view/section id", () => {
    expect(APPROVALS_SECTION_ID).toBe("approvals");
  });

  it("pins the standalone route path", () => {
    expect(APPROVALS_ROUTE_PATH).toBe("cloud/approvals");
  });
});

describe("approvalsCloudRoute definition", () => {
  it("targets the standalone approvals path under the cloud group", () => {
    expect(approvalsCloudRoute).toMatchObject({
      path: APPROVALS_ROUTE_PATH,
      group: "cloud",
    });
  });

  it("is not exposed as a public (sessionless) route", () => {
    expect(approvalsCloudRoute.public).toBeUndefined();
    expect(approvalsCloudRoute.publicAccess).toBeUndefined();
  });

  it("mounts a lazily-loaded (code-split) route element", () => {
    expect(approvalsCloudRoute.element).toBeTruthy();
    expect(
      (approvalsCloudRoute.element as { $$typeof?: symbol }).$$typeof,
    ).toBe(Symbol.for("react.lazy"));
  });
});

describe("import-time self-registration", () => {
  it("registers the standalone route into the shared registry on module load", () => {
    const route = getCloudRoute(APPROVALS_ROUTE_PATH);
    expect(route).toBeDefined();
    expect(route?.path).toBe(APPROVALS_ROUTE_PATH);
    expect(route?.group).toBe("cloud");
    expect(route?.element).toBeTruthy();
  });
});

describe("barrel re-export wiring", () => {
  const hookNames = [
    "useApprovalRequests",
    "useApproveRequest",
    "useBallots",
    "useCancelBallot",
    "useCancelSensitiveRequest",
    "useDenyRequest",
    "useSensitiveRequest",
    "useTallyBallot",
    "useVoteBallot",
  ] as const;

  for (const name of hookNames) {
    it(`binds ${name} to the real data-layer implementation`, () => {
      const fromBarrel = (approvalsBarrel as Record<string, unknown>)[name];
      const fromSource = (approvalsDataLayer as Record<string, unknown>)[name];
      expect(typeof fromBarrel).toBe("function");
      expect(fromBarrel).toBe(fromSource);
    });
  }

  it("re-exports ApprovalsSurface from the route module", () => {
    expect(approvalsBarrel.ApprovalsSurface).toBe(
      approvalsRouteModule.ApprovalsSurface,
    );
    expect(typeof approvalsBarrel.ApprovalsSurface).toBe("function");
  });

  it("exposes the route module default as ApprovalsRoute", () => {
    expect(approvalsBarrel.ApprovalsRoute).toBe(approvalsRouteModule.default);
    expect(typeof approvalsBarrel.ApprovalsRoute).toBe("function");
  });
});

describe("registerApprovalsCloudRoute against the real registry", () => {
  it("notifies registry subscribers on registration", () => {
    let notifications = 0;
    const unsubscribe = subscribeCloudRoutes(() => {
      notifications += 1;
    });
    try {
      registerApprovalsCloudRoute();
      expect(notifications).toBeGreaterThanOrEqual(1);
    } finally {
      unsubscribe();
    }
  });

  it("keeps exactly one entry per path when re-registering (last wins)", () => {
    registerApprovalsCloudRoute();
    registerApprovalsCloudRoute();
    const entries = listCloudRoutes().filter(
      (route) => route.path === APPROVALS_ROUTE_PATH,
    );
    expect(entries).toHaveLength(1);
  });

  it("preserves the built-in definition when called with no override", () => {
    registerApprovalsCloudRoute();
    const route = getCloudRoute(APPROVALS_ROUTE_PATH);
    expect(route).toMatchObject({
      path: APPROVALS_ROUTE_PATH,
      group: "cloud",
    });
    expect(route?.public).toBeUndefined();
    expect(route?.publicAccess).toBeUndefined();
    expect(route?.gate).toBeUndefined();
  });

  it("merges partial overrides without replacing untouched fields", () => {
    try {
      registerApprovalsCloudRoute({ gate: "admin" });
      const route = getCloudRoute(APPROVALS_ROUTE_PATH);
      expect(route?.gate).toBe("admin");
      expect(route?.path).toBe(APPROVALS_ROUTE_PATH);
      expect(route?.group).toBe("cloud");
      expect(route?.element).toBe(approvalsCloudRoute.element);
    } finally {
      registerApprovalsCloudRoute();
    }
  });

  it("supports a custom-path mount while leaving the default intact", () => {
    registerApprovalsCloudRoute({
      path: "cloud/approvals-custom-mount",
      group: "custom",
    });
    expect(getCloudRoute("cloud/approvals-custom-mount")).toMatchObject({
      path: "cloud/approvals-custom-mount",
      group: "custom",
    });
    const fallback = getCloudRoute(APPROVALS_ROUTE_PATH);
    expect(fallback).toBeDefined();
    expect(fallback?.group).toBe("cloud");
  });
});
