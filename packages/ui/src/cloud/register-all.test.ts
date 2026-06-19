import { describe, expect, it } from "vitest";
import { registerAllCloudSurfaces } from "./register-all";
import { listCloudRoutes } from "./shell/cloud-route-registry";

/**
 * Guards the boot-time wiring: every cloud domain must register its routes when
 * the app shell calls `registerAllCloudSurfaces()`. Without this, the
 * CloudRouterShell mounts an empty registry and no cloud/public route resolves.
 */
describe("registerAllCloudSurfaces", () => {
  it("populates the cloud-route registry with every domain's routes", () => {
    registerAllCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    for (const p of [
      "join",
      "dashboard/agents",
      "dashboard/api-keys",
      "dashboard/billing",
      "dashboard/account",
      "dashboard/security",
      "dashboard/organization",
      "dashboard/monetization",
      "dashboard/documents",
      "dashboard/api-explorer",
      "dashboard/apps",
      "dashboard/admin",
      "approve/:approvalId",
      "ballot/:ballotId",
      "sensitive-requests/:requestId",
      "payment/:paymentRequestId",
      "chat/:characterRef",
      "invite/accept",
      "login",
      "app-auth/authorize",
    ]) {
      expect(paths, `missing route ${p}`).toContain(p);
    }
  });
});
