/**
 * Unit coverage asserting full cloud registration wires every expected route.
 * Uses the synchronous entrypoint (register-all-sync) so the table is complete
 * before assertions — matching the legacy develop contract for test hosts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerPublicCloudSurfaces } from "./register-all";
import { registerAllCloudSurfaces } from "./register-all-sync";
import { getCloudRoute, listCloudRoutes } from "./shell/cloud-route-registry";

const progressiveSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "register-all.ts"),
  "utf8",
);
const syncSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "register-all-sync.ts"),
  "utf8",
);
const appMainSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/main.tsx"),
  "utf8",
);

describe("progressive register-all (public boot)", () => {
  it("keeps public registration free of static private dashboard imports", () => {
    expect(progressiveSource).toContain('from "./public-pages/register"');
    expect(progressiveSource).toContain('from "./join/register"');
    expect(progressiveSource).not.toMatch(/^import "\.\/instances"/m);
    expect(progressiveSource).not.toMatch(/^import "\.\/analytics"/m);
    // Public boot entry must not import the sync full-table module.
    expect(progressiveSource).not.toMatch(
      /from\s+["']\.\/register-all-sync["']/,
    );
    expect(appMainSource).toContain('import("@elizaos/ui/cloud/register-all")');
    expect(appMainSource).not.toContain("register-all-sync");

    registerPublicCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    expect(paths).toContain("login");
    expect(paths).toContain("join");
  });
});

describe("registerAllCloudSurfaces (sync legacy entrypoint)", () => {
  it("is a synchronous void function in register-all-sync", () => {
    expect(syncSource).toMatch(
      /export function registerAllCloudSurfaces\(\): void/,
    );
    expect(syncSource).toMatch(/^import "\.\/instances"/m);
  });

  it("populates the cloud-route registry with every domain's routes", () => {
    registerAllCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    for (const p of [
      "join",
      "dashboard",
      "dashboard/agents",
      "dashboard/my-agents",
      "dashboard/analytics",
      "dashboard/billing",
      "dashboard/billing/success",
      "dashboard/invoices/:id",
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

  it("leaves the web Cloud Apps handoff in the tab/view app", () => {
    registerAllCloudSurfaces();
    const cloudApps = getCloudRoute("cloud-apps");
    expect(cloudApps).toBeUndefined();
  });

  it("keeps legacy-only spellings as redirects, not routes", () => {
    registerAllCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
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
