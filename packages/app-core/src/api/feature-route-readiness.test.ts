/** Verifies deferred feature routes expose starting, ready, and failed states. */
import { describe, expect, it } from "vitest";
import { resolveFeatureRouteReadinessFailure } from "./feature-route-readiness.js";

describe("deferred feature route readiness", () => {
  it("returns runtime_starting before a runtime is published", () => {
    expect(
      resolveFeatureRouteReadinessFailure(
        "/api/lifeops/goals",
        false,
        undefined,
      ),
    ).toEqual({
      error: "feature_starting",
      phase: "app-route-tail",
      status: "runtime_starting",
    });
  });

  it("reports the deferred phase while route registration is pending", () => {
    expect(
      resolveFeatureRouteReadinessFailure(
        "/api/documents/123",
        true,
        "pending",
      ),
    ).toEqual({
      error: "feature_starting",
      phase: "app-route-tail",
      status: "pending",
    });
  });

  it("reports an unavailable feature when registration failed", () => {
    expect(
      resolveFeatureRouteReadinessFailure(
        "/api/wallet/market-overview",
        true,
        "failed",
      ),
    ).toEqual({
      error: "feature_unavailable",
      phase: "app-route-tail",
      status: "failed",
    });
  });

  it("falls through after registration and for unrelated paths", () => {
    expect(
      resolveFeatureRouteReadinessFailure("/api/lifeops", true, "complete"),
    ).toBeNull();
    expect(
      resolveFeatureRouteReadinessFailure(
        "/api/lifeops-extra",
        false,
        "pending",
      ),
    ).toBeNull();
    expect(
      resolveFeatureRouteReadinessFailure("/api/health", false, "pending"),
    ).toBeNull();
  });
});
