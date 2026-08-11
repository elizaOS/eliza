/**
 * Unit coverage asserting registerAllCloudSurfaces wires every expected cloud
 * route into the registry. In-memory registry, no runtime.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  registerAllCloudSurfaces,
  registerPublicCloudSurfaces,
} from "./register-all";
import { getCloudRoute, listCloudRoutes } from "./shell/cloud-route-registry";

const registerAllSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "register-all.ts"),
  "utf8",
);

/**
 * Guards the boot-time wiring: every cloud domain must register its routes when
 * the app shell calls `registerAllCloudSurfaces()`. Without this, the
 * CloudRouterShell mounts an empty registry and no cloud/public route resolves.
 */
describe("registerAllCloudSurfaces", () => {
  // Dynamic private domain import is cold-transform heavy under vitest on Windows.
  const fullRegistrationTimeoutMs = 60_000;

  it("keeps public registration free of static private dashboard imports", () => {
    // Source contract for #18056: public boot must not pull private domains or
    // the public-pages barrel (eager LoginPage re-exports).
    expect(registerAllSource).toContain('from "./public-pages/register"');
    expect(registerAllSource).toContain('from "./join/register"');
    expect(registerAllSource).not.toMatch(
      /import\s+\{\s*registerPublicPages\s*\}\s+from\s+"\.\/public-pages"/,
    );
    expect(registerAllSource).not.toMatch(/^import "\.\/instances"/m);
    expect(registerAllSource).not.toMatch(/^import "\.\/analytics"/m);
    expect(registerAllSource).toContain('import("./instances")');
    expect(registerAllSource).toContain(
      "export function registerPublicCloudSurfaces",
    );
    expect(registerAllSource).toContain(
      "export function registerPrivateCloudSurfaces",
    );

    registerPublicCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    expect(paths).toContain("login");
    expect(paths).toContain("join");
  });

  it(
    "populates the cloud-route registry with every domain's routes",
    async () => {
      await registerAllCloudSurfaces();
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
    },
    fullRegistrationTimeoutMs,
  );

  it(
    "leaves the web Cloud Apps handoff in the tab/view app",
    async () => {
      await registerAllCloudSurfaces();
      const cloudApps = getCloudRoute("cloud-apps");

      // Registering this as a top-level cloud route unmounts App and therefore
      // its navigate-view listener, stranding the user on the handoff surface.
      expect(cloudApps).toBeUndefined();
    },
    fullRegistrationTimeoutMs,
  );

  it(
    "keeps legacy-only spellings as redirects, not routes",
    async () => {
      await registerAllCloudSurfaces();
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
    },
    fullRegistrationTimeoutMs,
  );
});
