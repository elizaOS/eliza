/**
 * Unit tests for the cloud analytics route barrel: verifies the
 * `registerCloudRoute` side effect consumed by `CloudRouterShell` (path,
 * grouping, authed-by-default policy, lazily split page element) and the
 * re-exported time-range helpers, driven through the module's public exports.
 */
import { describe, expect, it } from "vitest";
import {
  type CloudRouteDef,
  getCloudRoute,
  listCloudRoutes,
} from "../shell/cloud-route-registry";
import {
  ANALYTICS_ROUTE_PATH,
  ANALYTICS_TIME_RANGES,
  AnalyticsPage,
  DEFAULT_ANALYTICS_TIME_RANGE,
  projectionPeriodsForRange,
  resolveTimeRangeParam,
} from "./index.ts";

describe("cloud/analytics index", () => {
  describe("route registration side effect", () => {
    it("registers the canonical org-level analytics route", () => {
      const route = getCloudRoute(ANALYTICS_ROUTE_PATH);

      expect(route).toBeDefined();
      expect(route?.path).toBe("cloud/analytics");
      expect(route?.group).toBe("cloud");
      // Authed-by-default: no public exposure opt-in, no central gate.
      expect(route?.public).toBeUndefined();
      expect(route?.publicAccess).toBeUndefined();
      expect(route?.gate).toBeUndefined();
    });

    it("exposes exactly one registry entry whose element is the exported lazy page", () => {
      const entries = listCloudRoutes().filter(
        (candidate) => candidate.path === ANALYTICS_ROUTE_PATH,
      );

      expect(entries).toHaveLength(1);
      const [entry] = entries as [CloudRouteDef];
      expect(entry.element).toBe(AnalyticsPage);
      // Code-splitting contract: the shell mounts a React.lazy component so
      // the chart bundle loads only when the view opens.
      const element = entry.element as { $$typeof?: symbol };
      expect(element.$$typeof).toBe(Symbol.for("react.lazy"));
    });
  });

  describe("re-exported resolveTimeRangeParam", () => {
    it("round-trips every advertised time-range bucket", () => {
      for (const range of ANALYTICS_TIME_RANGES) {
        expect(resolveTimeRangeParam(range)).toBe(range);
      }
    });

    it("falls back to the exported default for missing or unknown params", () => {
      expect(resolveTimeRangeParam(null)).toBe(DEFAULT_ANALYTICS_TIME_RANGE);
      expect(resolveTimeRangeParam(undefined)).toBe(
        DEFAULT_ANALYTICS_TIME_RANGE,
      );
      expect(resolveTimeRangeParam("")).toBe(DEFAULT_ANALYTICS_TIME_RANGE);
      expect(resolveTimeRangeParam("yearly")).toBe(
        DEFAULT_ANALYTICS_TIME_RANGE,
      );
      expect(resolveTimeRangeParam("DAILY")).toBe(DEFAULT_ANALYTICS_TIME_RANGE);
      expect(resolveTimeRangeParam(" daily ")).toBe(
        DEFAULT_ANALYTICS_TIME_RANGE,
      );
    });
  });

  describe("re-exported projectionPeriodsForRange", () => {
    it("maps each bucket to its documented projection horizon in days", () => {
      expect(projectionPeriodsForRange("daily")).toBe(1);
      expect(projectionPeriodsForRange("weekly")).toBe(7);
      expect(projectionPeriodsForRange("monthly")).toBe(30);
    });
  });
});
