/**
 * Deterministically verifies that only exact hosted public routes bypass the
 * full renderer entry, while desktop/native-style and near-miss paths retain
 * the established application boot.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isHostedPublicPath,
  shouldUseMarketingHomeEntry,
  shouldUsePublicWebEntry,
} from "./web-entry-policy";

const PUBLIC_PATHS = [
  "/account-deletion",
  "/login",
  "/login/",
  "/auth/success",
  "/auth/callback/email",
  "/payment/request-1",
  "/payment/app-charge/app-1/charge-1",
  "/approve/approval-1",
  "/ballot/ballot-1",
  "/sensitive-requests/request-1",
  "/chat/character-1",
  "/join",
  "/get-started",
  "/terms-of-service",
] as const;

const appRoot = resolve(import.meta.dirname, "..");
const uiRoot = resolve(appRoot, "../ui");

/** Paths owned by the public Cloud shell but not registered as cloud routes. */
const MARKETING_SHELL_PATHS = new Set(["/downloads"]);

/**
 * Extract `path: "..."` registrations from cloud domain register modules.
 * Source-level on purpose: avoids coupling the app policy test to registry
 * runtime internals while still failing when either side mutates alone.
 */
function extractRegisteredCloudPaths(source: string): string[] {
  const paths: string[] = [];
  const pathLiteral = /path:\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pathLiteral)) {
    paths.push(match[1]);
  }
  // join/register exports path constants referenced by registerCloudRoute.
  const constPath = /export const \w+_ROUTE_PATH = ["']([^"']+)["']/g;
  for (const match of source.matchAll(constPath)) {
    paths.push(match[1]);
  }
  return [...new Set(paths)];
}

/** Convert a cloud-route path template into sample URL pathnames. */
function samplePathnamesForRoute(routePath: string): string[] {
  const segments = routePath.split("/").filter(Boolean);
  const concrete = segments.map((segment) =>
    segment.startsWith(":") ? "sample" : segment,
  );
  return [`/${concrete.join("/")}`];
}

function extractPolicyExactPaths(policySource: string): string[] {
  const block = policySource.match(
    /const EXACT_PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\)/,
  );
  if (!block) return [];
  return [...block[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function extractPolicyParamPatterns(policySource: string): RegExp[] {
  const block = policySource.match(
    /const PARAMETRIC_PUBLIC_PATHS = \[([\s\S]*?)\] as const/,
  );
  if (!block) return [];
  const patterns: RegExp[] = [];
  for (const line of block[1].split("\n")) {
    const literal = line.trim().replace(/,$/, "");
    if (!literal.startsWith("/")) continue;
    const closingSlash = literal.lastIndexOf("/");
    if (closingSlash <= 0) continue;
    patterns.push(
      new RegExp(
        literal.slice(1, closingSlash),
        literal.slice(closingSlash + 1),
      ),
    );
  }
  return patterns;
}

describe("hosted public renderer entry policy", () => {
  it("ships the selector as the HTML entry and keeps all renderers dynamic", () => {
    const indexHtml = readFileSync(resolve(appRoot, "index.html"), "utf8");
    const entrySource = readFileSync(resolve(appRoot, "src/entry.ts"), "utf8");
    const publicEntrySource = readFileSync(
      resolve(appRoot, "src/public-web-entry.tsx"),
      "utf8",
    );

    expect(indexHtml).toContain('src="/src/entry.ts"');
    expect(entrySource).toContain('import("./public-web-entry")');
    expect(entrySource).toContain('import("./marketing-home-entry")');
    expect(entrySource).toContain('import("./main")');
    expect(publicEntrySource).not.toMatch(/from\s+["']\.\/main["']/);
    expect(publicEntrySource).toContain('import("./main")');
    expect(publicEntrySource).not.toContain("window.location.reload()");
    expect(publicEntrySource).toContain("seedPublicWebBootConfig");
  });

  it.each(PUBLIC_PATHS)("recognizes registered public path %s", (pathname) => {
    expect(isHostedPublicPath(pathname)).toBe(true);
  });

  it.each([
    "/cloud",
    "/settings",
    "/chat",
    "/payment",
    "/payment/app-charge/app-only",
    "/approve/id/extra",
    "/unknown",
  ])("rejects non-public or near-miss path %s", (pathname) => {
    expect(isHostedPublicPath(pathname)).toBe(false);
  });

  it("uses the public entry for marketing home but not app-host home", () => {
    const common = {
      pathname: "/",
      webShellEnabled: true,
      chatHarnessEnabled: false,
      desktopShell: false,
      forceApexConsole: false,
    };
    expect(shouldUsePublicWebEntry({ ...common, hostname: "eliza.app" })).toBe(
      true,
    );
    expect(
      shouldUseMarketingHomeEntry({ ...common, hostname: "eliza.app" }),
    ).toBe(true);
    expect(
      shouldUsePublicWebEntry({ ...common, hostname: "cloud.eliza.app" }),
    ).toBe(false);
    expect(
      shouldUseMarketingHomeEntry({ ...common, hostname: "cloud.eliza.app" }),
    ).toBe(false);
  });

  it("keeps auth routes and forced apex console out of the marketing-only entry", () => {
    const common = {
      hostname: "eliza.app",
      webShellEnabled: true,
      chatHarnessEnabled: false,
      desktopShell: false,
      forceApexConsole: false,
    };
    expect(shouldUseMarketingHomeEntry({ ...common, pathname: "/login" })).toBe(
      false,
    );
    expect(
      shouldUseMarketingHomeEntry({
        ...common,
        hostname: "cloud.eliza.app",
        pathname: "/",
        forceApexConsole: true,
      }),
    ).toBe(false);
  });

  it("keeps the marketing entry free of auth-router and service-worker startup", () => {
    const marketingEntrySource = readFileSync(
      resolve(appRoot, "src/marketing-home-entry.tsx"),
      "utf8",
    );
    expect(marketingEntrySource).toContain(
      'import EmbeddedHomePage from "@homepage/embedded-home"',
    );
    expect(marketingEntrySource).not.toContain("CloudRouterShell");
    expect(marketingEntrySource).not.toContain("registerPublicCloudSurfaces");
    expect(marketingEntrySource).not.toContain("registerViewServiceWorker");
  });

  it("never bypasses the established desktop, disabled-shell, or harness boot", () => {
    const common = {
      pathname: "/login",
      hostname: "eliza.app",
      webShellEnabled: true,
      chatHarnessEnabled: false,
      desktopShell: false,
      forceApexConsole: false,
    };
    expect(shouldUsePublicWebEntry({ ...common, desktopShell: true })).toBe(
      false,
    );
    expect(shouldUsePublicWebEntry({ ...common, webShellEnabled: false })).toBe(
      false,
    );
    expect(
      shouldUsePublicWebEntry({ ...common, chatHarnessEnabled: true }),
    ).toBe(false);
  });

  it("keeps web-entry policy paths synchronized with public/join route registration", () => {
    const policySource = readFileSync(
      resolve(appRoot, "src/web-entry-policy.ts"),
      "utf8",
    );
    const publicPagesSource = readFileSync(
      resolve(uiRoot, "src/cloud/public-pages/register.ts"),
      "utf8",
    );
    const joinSource = readFileSync(
      resolve(uiRoot, "src/cloud/join/register.ts"),
      "utf8",
    );

    const registeredRoutes = [
      ...extractRegisteredCloudPaths(publicPagesSource),
      ...extractRegisteredCloudPaths(joinSource),
    ];
    expect(registeredRoutes.length).toBeGreaterThan(10);

    // Every registered public/join route must be owned by the lightweight
    // entry policy; otherwise navigation stays on the public shell and
    // FullAppHandoff reload-loops or never reaches the full app.
    for (const routePath of registeredRoutes) {
      for (const sample of samplePathnamesForRoute(routePath)) {
        expect(
          isHostedPublicPath(sample),
          `registered route "${routePath}" sample "${sample}" missing from web-entry policy`,
        ).toBe(true);
      }
    }

    const exactPolicyPaths = extractPolicyExactPaths(policySource).filter(
      (path) => !MARKETING_SHELL_PATHS.has(path),
    );

    // Every exact policy path (except marketing shell props) must appear in a
    // register module so policy-only additions cannot silently diverge.
    const registeredPathSet = new Set(
      registeredRoutes.map((route) => route.replace(/^\/+/, "")),
    );
    for (const policyPath of exactPolicyPaths) {
      const normalized = policyPath.replace(/^\/+/, "");
      expect(
        registeredPathSet.has(normalized),
        `policy exact path "${policyPath}" has no matching cloud route registration`,
      ).toBe(true);
    }

    const parametricPatterns = extractPolicyParamPatterns(policySource);
    // Parametric policy patterns must each match at least one registered
    // template sample (mutation-sensitive: adding only one side fails).
    for (const pattern of parametricPatterns) {
      const matched = registeredRoutes.some((routePath) =>
        samplePathnamesForRoute(routePath).some((sample) =>
          pattern.test(sample),
        ),
      );
      expect(
        matched,
        `parametric policy ${pattern} matches no registered cloud route sample`,
      ).toBe(true);
    }

    // Sabotage-style pin: a synthetic policy-only path must not be considered
    // registered, proving the assertions above are not vacuously true.
    expect(registeredPathSet.has("policy-only-sabotage-path")).toBe(false);
    expect(isHostedPublicPath("/policy-only-sabotage-path")).toBe(false);
  });
});
