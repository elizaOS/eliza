/**
 * Unit coverage for the branding barrel: every runtime symbol a consumer
 * reaches through `config/branding` must be the same binding as its owning
 * module, and the branding-base values it exposes keep their pinned defaults
 * and interpolation fallbacks. Deterministic pure data; no mocks.
 */

import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { describe, expect, it } from "vitest";
import * as barrel from "./branding";
import type { BrandingConfig } from "./branding-base";
import {
  appNameInterpolationVars,
  DEFAULT_APP_DISPLAY_NAME,
  DEFAULT_BRANDING,
} from "./branding-base";
import { BrandingContext, useBranding } from "./branding-react.hooks";

describe("config/branding barrel", () => {
  it("re-exports each branding-base runtime binding by identity, not copy", () => {
    expect(barrel.DEFAULT_APP_DISPLAY_NAME).toBe(DEFAULT_APP_DISPLAY_NAME);
    expect(barrel.DEFAULT_BRANDING).toBe(DEFAULT_BRANDING);
    expect(barrel.appNameInterpolationVars).toBe(appNameInterpolationVars);
  });

  it("re-exports the React context and hook by identity so provider trees and consumers share one context object", () => {
    expect(barrel.BrandingContext).toBe(BrandingContext);
    expect(barrel.useBranding).toBe(useBranding);
  });
});

describe("appNameInterpolationVars", () => {
  it("returns the configured appName verbatim for a normal name", () => {
    const branding = { ...DEFAULT_BRANDING, appName: "Aurora" };
    expect(appNameInterpolationVars(branding)).toEqual({ appName: "Aurora" });
  });

  it("trims surrounding whitespace instead of interpolating padded copy", () => {
    const branding = { ...DEFAULT_BRANDING, appName: "  Padded App  " };
    expect(appNameInterpolationVars(branding)).toEqual({
      appName: "Padded App",
    });
  });

  it("falls back to DEFAULT_APP_DISPLAY_NAME when appName is an empty string", () => {
    const branding = { ...DEFAULT_BRANDING, appName: "" };
    expect(appNameInterpolationVars(branding)).toEqual({
      appName: DEFAULT_APP_DISPLAY_NAME,
    });
  });

  it("falls back when appName is whitespace-only (trim leaves nothing)", () => {
    const branding = { ...DEFAULT_BRANDING, appName: " \t\n " };
    expect(appNameInterpolationVars(branding)).toEqual({
      appName: DEFAULT_APP_DISPLAY_NAME,
    });
  });

  it("falls back when appName is undefined, as unvalidated legacy payloads reach the optional chain", () => {
    const legacy = {
      ...DEFAULT_BRANDING,
      appName: undefined,
    } as unknown as BrandingConfig;
    expect(appNameInterpolationVars(legacy)).toEqual({
      appName: DEFAULT_APP_DISPLAY_NAME,
    });
  });
});

describe("DEFAULT_BRANDING", () => {
  it("derives appName from the single DEFAULT_APP_DISPLAY_NAME constant", () => {
    expect(DEFAULT_APP_DISPLAY_NAME).toBe("Eliza");
    expect(DEFAULT_BRANDING.appName).toBe(DEFAULT_APP_DISPLAY_NAME);
  });

  it("pins the repository identity fields", () => {
    expect(DEFAULT_BRANDING.orgName).toBe("elizaos");
    expect(DEFAULT_BRANDING.repoName).toBe("eliza");
    expect(DEFAULT_BRANDING.packageScope).toBe("elizaos");
    expect(DEFAULT_BRANDING.fileExtension).toBe(".eliza-agent");
    expect(DEFAULT_BRANDING.hashtag).toBe("#ElizaAgent");
  });

  it("wires docs and app URLs to the shared brand EXTERNAL_URLS rather than local literals", () => {
    expect(DEFAULT_BRANDING.docsUrl).toBe(EXTERNAL_URLS.docs);
    expect(DEFAULT_BRANDING.appUrl).toBe(EXTERNAL_URLS.app);
  });

  it("points bug reports at the repository's bug_report issue template", () => {
    expect(DEFAULT_BRANDING.bugReportUrl).toBe(
      "https://github.com/elizaos/eliza/issues/new?template=bug_report.yml",
    );
  });

  it("ships with no injected custom providers, theme overrides, or cloud-only lock-in", () => {
    expect(DEFAULT_BRANDING.customProviders).toBeUndefined();
    expect(DEFAULT_BRANDING.firstRunTheme).toBeUndefined();
    expect(DEFAULT_BRANDING.theme).toBeUndefined();
    expect(DEFAULT_BRANDING.cloudOnly).toBeUndefined();
  });
});
