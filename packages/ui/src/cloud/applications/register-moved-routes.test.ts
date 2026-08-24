/**
 * Unit tests for register-moved-routes: validates application route path constants.
 */
import { describe, expect, it } from "vitest";
import {
  APPLICATIONS_DETAIL_ROUTE_PATH,
  APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH,
  APPLICATIONS_LEGACY_LIST_ROUTE_PATH,
  APPLICATIONS_LIST_ROUTE_PATH,
  registerMovedApplicationsCloudRoutes,
} from "./register-moved-routes.ts";

describe("register-moved-routes", () => {
  it("exports canonical and legacy application route paths", () => {
    expect(APPLICATIONS_LIST_ROUTE_PATH).toBe("cloud/apps");
    expect(APPLICATIONS_DETAIL_ROUTE_PATH).toBe("cloud/apps/:id");
    expect(APPLICATIONS_LEGACY_LIST_ROUTE_PATH).toBe("cloud/applications");
    expect(APPLICATIONS_LEGACY_DETAIL_ROUTE_PATH).toBe(
      "cloud/applications/:id",
    );
  });

  it("executes route registration without throwing", () => {
    expect(() => registerMovedApplicationsCloudRoutes()).not.toThrow();
  });
});
