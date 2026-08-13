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
  shouldUsePublicWebEntry,
} from "./web-entry-policy";

const PUBLIC_PATHS = [
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

describe("hosted public renderer entry policy", () => {
  it("ships the selector as the HTML entry and keeps both renderers dynamic", () => {
    const appRoot = resolve(import.meta.dirname, "..");
    const indexHtml = readFileSync(resolve(appRoot, "index.html"), "utf8");
    const entrySource = readFileSync(resolve(appRoot, "src/entry.ts"), "utf8");
    const publicEntrySource = readFileSync(
      resolve(appRoot, "src/public-web-entry.tsx"),
      "utf8",
    );

    expect(indexHtml).toContain('src="/src/entry.ts"');
    expect(entrySource).toContain('import("./public-web-entry")');
    expect(entrySource).toContain('import("./main")');
    expect(publicEntrySource).not.toMatch(/from\s+["']\.\/main["']/);
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
      shouldUsePublicWebEntry({ ...common, hostname: "cloud.eliza.app" }),
    ).toBe(false);
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
});
