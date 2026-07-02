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
      // Analytics registers as an import side effect — this entry is the guard
      // that the register-all import stays wired (it shipped forgotten once:
      // page fully built, route 404ing on the dashboard/* catch-all).
      "dashboard/analytics",
      "dashboard/billing",
      "dashboard/account",
      "dashboard/security",
      "dashboard/organization",
      "dashboard/monetization",
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

  it("mounts the API-keys surface only once — no standalone dashboard/api-keys route", () => {
    registerAllCloudSurfaces();
    const apiKeysRoutes = listCloudRoutes().filter(
      (r) => r.path === "dashboard/api-keys",
    );
    // The single API-keys mount is the Settings → Developer section; legacy
    // `/dashboard/api-keys` deep links resolve to it via the CloudRouterShell
    // compat redirect, NOT a registered route.
    expect(apiKeysRoutes).toHaveLength(0);
  });
});
