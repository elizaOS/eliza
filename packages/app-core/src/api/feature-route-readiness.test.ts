/** Verifies deferred feature routes expose starting, ready, and failed states. */
import { describe, expect, it } from "vitest";
import {
  isFeatureRouteHandlerAvailable,
  resolveFeatureRouteReadinessFailure,
} from "./feature-route-readiness.js";

describe("deferred feature route readiness", () => {
  it("returns runtime_starting before a runtime is published", () => {
    expect(
      resolveFeatureRouteReadinessFailure("/api/lifeops/goals", false, {}),
    ).toEqual({
      error: "feature_starting",
      code: "feature_starting",
      phase: "app-route-tail",
      status: "runtime_starting",
      retryable: true,
    });
  });

  it("reports the deferred phase while route registration is pending", () => {
    expect(
      resolveFeatureRouteReadinessFailure("/api/documents/123", true, {
        "app-route-tail": "pending",
      }),
    ).toEqual({
      error: "feature_starting",
      code: "feature_starting",
      phase: "app-route-tail",
      status: "pending",
      retryable: true,
    });
  });

  it("reports an unavailable feature when registration failed", () => {
    expect(
      resolveFeatureRouteReadinessFailure("/api/documents/document-1", true, {
        "app-route-tail": "failed",
      }),
    ).toEqual({
      error: "feature_unavailable",
      code: "feature_unavailable",
      phase: "app-route-tail",
      status: "failed",
      retryable: false,
    });
  });

  it.each(["/api/notes/state", "/api/views/notes/interact"])(
    "keeps Notes route %s in a starting state until its runtime plugin registers",
    (path) => {
      expect(
        resolveFeatureRouteReadinessFailure(path, false, {}),
      ).toMatchObject({
        code: "feature_starting",
        retryable: true,
        status: "runtime_starting",
      });
    },
  );

  it.each([
    "/api/browser-workspace",
    "/api/browser-workspace/tabs/tab-1/navigate",
  ])(
    "keeps Browser workspace route %s in a starting state until its runtime plugin registers",
    (path) => {
      expect(
        resolveFeatureRouteReadinessFailure(path, false, {}),
      ).toMatchObject({
        code: "feature_starting",
        retryable: true,
        status: "runtime_starting",
      });
    },
  );

  it("keeps plugin-owned routes starting until the agent deferred wave settles", () => {
    expect(
      resolveFeatureRouteReadinessFailure("/api/notes/state", true, {
        "agent-deferred-boot": "pending",
        "app-route-tail": "complete",
      }),
    ).toEqual({
      error: "feature_starting",
      code: "feature_starting",
      phase: "agent-deferred-boot",
      status: "pending",
      retryable: true,
    });
  });

  it.each([
    ["GET", "/api/browser-workspace"],
    ["POST", "/api/browser-workspace/tabs"],
    ["GET", "/api/computer-use/approvals"],
    ["GET", "/api/wallet/addresses"],
    ["GET", "/api/wallet/steward-status"],
  ])(
    "does not let a global boot phase shadow host-owned %s %s",
    (method, pathname) => {
      const handlerAvailable = isFeatureRouteHandlerAvailable({
        method,
        pathname,
      });
      expect(handlerAvailable).toBe(true);
      for (const status of ["pending", "failed"] as const) {
        expect(
          resolveFeatureRouteReadinessFailure(
            pathname,
            true,
            {
              "agent-deferred-boot": status,
              "app-route-tail": "complete",
            },
            handlerAvailable,
          ),
        ).toBeNull();
      }
    },
  );

  it.each([
    ["GET", "/api/coding-agents/preflight"],
    ["GET", "/api/coding-agents/coordinator/status"],
    ["GET", "/api/lifeops/inbox"],
    ["POST", "/api/lifeops/activity-signals"],
  ])(
    "preserves the exact host fallback for %s %s when unrelated boot work fails",
    (method, pathname) => {
      const handlerAvailable = isFeatureRouteHandlerAvailable({
        method,
        pathname,
      });
      expect(handlerAvailable).toBe(true);
      expect(
        resolveFeatureRouteReadinessFailure(
          pathname,
          true,
          { "agent-deferred-boot": "failed" },
          handlerAvailable,
        ),
      ).toBeNull();
    },
  );

  it("lets a registered parameterized runtime route outrank global pending and failed phases", () => {
    const handlerAvailable = isFeatureRouteHandlerAvailable({
      method: "GET",
      pathname: "/api/documents/document-1",
      runtimeRoutes: [
        {
          type: "GET",
          path: "/api/documents/:id",
          routeHandler: async () => ({ status: 200 }),
        },
      ],
    });

    expect(handlerAvailable).toBe(true);
    for (const status of ["pending", "failed"] as const) {
      expect(
        resolveFeatureRouteReadinessFailure(
          "/api/documents/document-1",
          true,
          {
            "agent-deferred-boot": status,
            "app-route-tail": "complete",
          },
          handlerAvailable,
        ),
      ).toBeNull();
    }
  });

  it("does not treat a non-executable or wrong-method runtime route as ready", () => {
    expect(
      isFeatureRouteHandlerAvailable({
        method: "GET",
        pathname: "/api/notes/state",
        runtimeRoutes: [
          { type: "POST", path: "/api/notes/state" },
          { type: "GET", path: "/api/notes/state" },
        ],
      }),
    ).toBe(false);
  });

  it("falls through after registration and for unrelated paths", () => {
    expect(
      resolveFeatureRouteReadinessFailure("/api/lifeops", true, {
        "agent-deferred-boot": "complete",
        "app-route-tail": "complete",
      }),
    ).toBeNull();
    expect(
      resolveFeatureRouteReadinessFailure("/api/lifeops-extra", false, {
        "app-route-tail": "pending",
      }),
    ).toBeNull();
    expect(
      resolveFeatureRouteReadinessFailure("/api/health", false, {
        "app-route-tail": "pending",
      }),
    ).toBeNull();
  });
});
