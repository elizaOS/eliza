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
      "dashboard/my-agents",
      // Analytics registers as an import side effect — this entry guards that
      // the register-all import stays wired.
      "dashboard/analytics",
      // Stripe return URL + invoice detail (flow pages, not a billing home).
      "dashboard/billing/success",
      "dashboard/invoices/:id",
      "dashboard/organization",
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

  it("mounts each account-management surface exactly once — in Settings, with no standalone dashboard route", () => {
    registerAllCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    // The single mount for each of these is its Settings section; legacy
    // /dashboard/* deep links resolve to it via the CloudRouterShell compat
    // redirects (which only fire when no identically-pathed route shadows
    // them), NOT a registered route.
    for (const p of [
      "dashboard/api-keys",
      "dashboard/billing",
      "dashboard/monetization",
      "dashboard/earnings",
      "dashboard/affiliates",
      "dashboard/account",
      "dashboard/security",
      "dashboard/security/permissions",
      "dashboard/settings",
      "dashboard/settings/connections",
    ]) {
      expect(paths, `unexpected standalone route ${p}`).not.toContain(p);
    }
  });
});
