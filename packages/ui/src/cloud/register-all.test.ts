/**
 * Unit coverage asserting full cloud registration wires every expected route,
 * and that the progressive public entrypoint stays free of private domains.
 *
 * `register-all` preserves the develop synchronous `(): void` contract —
 * callers that register then immediately read the registry must see a complete
 * table.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registerAllCloudSurfaces } from "./register-all";
import { registerPublicCloudSurfaces } from "./register-public";
import { getCloudRoute, listCloudRoutes } from "./shell/cloud-route-registry";

const registerAllSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "register-all.ts"),
  "utf8",
);
const registerPublicSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "register-public.ts"),
  "utf8",
);
const appMainSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/main.tsx"),
  "utf8",
);

describe("registerAllCloudSurfaces (sync public API contract)", () => {
  it("exports a synchronous void function at the original register-all path", () => {
    expect(registerAllSource).toMatch(
      /export function registerAllCloudSurfaces\(\): void/,
    );
    expect(registerAllSource).not.toMatch(
      /export async function registerAllCloudSurfaces/,
    );
    expect(registerAllSource).toMatch(/^import "\.\/instances"/m);
    expect(registerAllSource).toMatch(/^import "\.\/analytics"/m);
  });

  it("populates the cloud-route registry before the next statement", () => {
    registerAllCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    for (const p of [
      "join",
      "cloud",
      "cloud/agents",
      "cloud/my-agents",
      "cloud/analytics",
      "cloud/billing",
      "cloud/billing/success",
      "cloud/invoices/:id",
      "cloud/api-keys",
      "cloud/account",
      "cloud/security",
      "cloud/security/permissions",
      "cloud/monetization",
      "cloud/connectors",
      "cloud/organization",
      "cloud/api-explorer",
      "cloud/apps",
      "cloud/apps/:id",
      "cloud/applications",
      "cloud/applications/:id",
      "cloud/admin",
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

  it("maps legacy Applications URLs to the moved Apps route", () => {
    registerAllCloudSurfaces();
    const movedAppsRoute = getCloudRoute("cloud/apps");
    expect(movedAppsRoute).toBeDefined();
    expect(getCloudRoute("cloud/apps/:id")?.element).toBe(
      movedAppsRoute?.element,
    );
    expect(getCloudRoute("cloud/applications")?.element).toBe(
      movedAppsRoute?.element,
    );
    expect(getCloudRoute("cloud/applications/:id")?.element).toBe(
      movedAppsRoute?.element,
    );
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
      "cloud/earnings",
      "cloud/affiliates",
      "cloud/settings",
      "cloud/settings/connections",
    ]) {
      expect(paths, `unexpected standalone route ${p}`).not.toContain(p);
    }
  });
});

describe("progressive register-public (anonymous /login boot)", () => {
  it("keeps public registration free of static private dashboard imports", () => {
    expect(registerPublicSource).toContain('from "./public-pages/register"');
    expect(registerPublicSource).toContain('from "./join/register"');
    expect(registerPublicSource).not.toMatch(/^import "\.\/instances"/m);
    expect(registerPublicSource).not.toMatch(/^import "\.\/analytics"/m);
    expect(registerPublicSource).not.toMatch(/from\s+["']\.\/register-all["']/);
    expect(registerPublicSource).not.toMatch(
      /from\s+["']\.\/register-all-sync["']/,
    );
  });

  it("is the packages/app shell factory import path (not register-all)", () => {
    expect(appMainSource).toContain(
      'import("@elizaos/ui/cloud/register-public")',
    );
    expect(appMainSource).not.toMatch(
      /import\("@elizaos\/ui\/cloud\/register-all"\)/,
    );
    expect(appMainSource).toContain("registerPublicCloudSurfaces()");
  });

  it("registers public auth routes without requiring private domains", () => {
    registerPublicCloudSurfaces();
    const paths = new Set(listCloudRoutes().map((r) => r.path));
    expect(paths).toContain("login");
    expect(paths).toContain("join");
  });
});
