/** Verifies approvals cloud-route registration through the package's configured test harness. */
import { describe, expect, it } from "vitest";
import { registerAllCloudSurfaces } from "../register-all";
import { listCloudRoutes } from "../shell/cloud-route-registry";
import { APPROVALS_ROUTE_PATH } from "./index";

/**
 * Proves the approvals domain registers into the same cloud-route registry
 * consumed by the web-only CloudRouterShell.
 */
describe("approvals cloud-route registration", () => {
  const fullRegistrationTimeoutMs = 60_000;

  it(
    "registers the approvals route into the shared registry",
    async () => {
      await registerAllCloudSurfaces();
      const paths = new Set(listCloudRoutes().map((r) => r.path));
      expect(paths, `missing ${APPROVALS_ROUTE_PATH}`).toContain(
        APPROVALS_ROUTE_PATH,
      );
      expect(APPROVALS_ROUTE_PATH).toBe("dashboard/approvals");
    },
    fullRegistrationTimeoutMs,
  );

  it(
    "resolves the approvals route to a renderable element",
    async () => {
      await registerAllCloudSurfaces();
      const route = listCloudRoutes().find(
        (r) => r.path === APPROVALS_ROUTE_PATH,
      );
      expect(route).toBeDefined();
      expect(route?.element).toBeTruthy();
      expect(route?.group).toBe("dashboard");
    },
    fullRegistrationTimeoutMs,
  );
});
