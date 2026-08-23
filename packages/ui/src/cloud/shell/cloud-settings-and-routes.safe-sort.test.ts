/**
 * Verifies safe sorting in cloud extra settings groups and route registry when order contains NaN or non-finite numbers.
 */

import { describe, expect, it } from "vitest";
import {
  listExtraSettingsGroups,
  registerSettingsGroup,
} from "../settings/cloud-settings-group.js";
import {
  listCloudRoutes,
  registerCloudRoute,
} from "./cloud-route-registry.js";
import React from "react";

describe("cloud settings and routes safe sort", () => {
  it("safely lists extra settings groups when order contains NaN or non-finite values", () => {
    registerSettingsGroup({
      id: "group-high",
      label: "High Group",
      order: 100,
    });
    registerSettingsGroup({
      id: "group-nan",
      label: "NaN Group",
      order: NaN,
    });
    registerSettingsGroup({
      id: "group-low",
      label: "Low Group",
      order: 10,
    });

    const groups = listExtraSettingsGroups();
    expect(groups.length).toBeGreaterThanOrEqual(3);
    const ids = groups.map((g) => g.id);
    expect(ids).toContain("group-nan");
    expect(ids).toContain("group-low");
    expect(ids).toContain("group-high");
  });

  it("safely lists cloud routes when order contains NaN or non-finite values", () => {
    registerCloudRoute({
      path: "/cloud/route-1",
      element: React.createElement("div"),
      order: 50,
    });
    registerCloudRoute({
      path: "/cloud/route-nan",
      element: React.createElement("div"),
      order: NaN,
    });
    registerCloudRoute({
      path: "/cloud/route-2",
      element: React.createElement("div"),
      order: 10,
    });

    const routes = listCloudRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(3);
    const paths = routes.map((r) => r.path);
    expect(paths).toContain("/cloud/route-nan");
    expect(paths).toContain("/cloud/route-2");
    expect(paths).toContain("/cloud/route-1");
  });
});
