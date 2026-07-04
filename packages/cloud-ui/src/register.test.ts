import { listCloudRoutes } from "@elizaos/ui/cloud/shell/cloud-route-registry";
import { describe, expect, it } from "vitest";
import { APPROVALS_ROUTE_PATH, registerCloudUiSurfaces } from "./index";

/**
 * Proves the package boundary end-to-end: a cloud surface that lives in
 * `@elizaos/cloud-ui` (not in the `@elizaos/ui` trunk) registers into the SAME
 * process-global cloud-route registry the trunk `CloudRouterShell` reads. This
 * is what lets the shell render cloud-ui routes without the trunk importing the
 * product UI — and what lets cloud-free builds drop this package with no stub.
 */
describe("@elizaos/cloud-ui self-registration", () => {
  it("registers its cloud routes into @elizaos/ui's shared registry", () => {
    // Importing the barrel already runs the approvals module's import-time
    // registration; the explicit hook is idempotent and mirrors the app shell.
    registerCloudUiSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    expect(paths, `missing ${APPROVALS_ROUTE_PATH}`).toContain(
      APPROVALS_ROUTE_PATH,
    );
    expect(APPROVALS_ROUTE_PATH).toBe("dashboard/approvals");
  });

  it("resolves the approvals route to a renderable element", () => {
    registerCloudUiSurfaces();
    const route = listCloudRoutes().find(
      (r) => r.path === APPROVALS_ROUTE_PATH,
    );
    expect(route).toBeDefined();
    expect(route?.element).toBeTruthy();
    expect(route?.group).toBe("dashboard");
  });
});
