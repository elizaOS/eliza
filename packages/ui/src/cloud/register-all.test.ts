/**
 * Unit coverage asserting registerAllCloudSurfaces wires every expected cloud
 * route into the registry. In-memory registry, no runtime.
 */
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
      // The console home — the apex catch-all's authenticated landing.
      "dashboard",
      "dashboard/agents",
      "dashboard/my-agents",
      // Analytics registers as an import side effect — this entry guards that
      // the register-all import stays wired.
      "dashboard/analytics",
      // Billing home + Stripe return URL + invoice detail.
      "dashboard/billing",
      "dashboard/billing/success",
      "dashboard/invoices/:id",
      // Account-management console pages. These are what make the apex console
      // (elizacloud.ai) usable — the agent app (and its in-app Settings view)
      // never boots on a control-plane host.
      "dashboard/api-keys",
      "dashboard/account",
      "dashboard/security",
      "dashboard/security/permissions",
      "dashboard/monetization",
      "dashboard/connectors",
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

  it("keeps legacy-only spellings as redirects, not routes", () => {
    registerAllCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    // These resolve via the CloudRouterShell compat redirects (earnings /
    // affiliates → the monetization page; dashboard/settings?tab=<x> → the
    // matching console page). Registering them as routes too would shadow the
    // redirects and fork the canonical homes.
    for (const p of [
      "dashboard/earnings",
      "dashboard/affiliates",
      "dashboard/settings",
      "dashboard/settings/connections",
    ]) {
      expect(paths, `unexpected standalone route ${p}`).not.toContain(p);
    }
  });
});
