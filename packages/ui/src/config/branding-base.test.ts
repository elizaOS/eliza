/**
 * Unit coverage for the base branding defaults and the {{appName}}
 * interpolation helper. Pure data plus one pure function, no runtime.
 */

import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { describe, expect, it } from "vitest";

import type { BrandingConfig } from "./branding-base";
import {
  appNameInterpolationVars,
  DEFAULT_APP_DISPLAY_NAME,
  DEFAULT_BRANDING,
} from "./branding-base";

describe("DEFAULT_APP_DISPLAY_NAME", () => {
  it("is the Eliza product name that i18n copy interpolates for {{appName}}", () => {
    expect(DEFAULT_APP_DISPLAY_NAME).toBe("Eliza");
  });
});

describe("DEFAULT_BRANDING", () => {
  it("uses the Eliza display name", () => {
    expect(DEFAULT_BRANDING.appName).toBe("Eliza");
    expect(DEFAULT_BRANDING.appName).toBe(DEFAULT_APP_DISPLAY_NAME);
  });

  it("points org, repo, and npm scope at elizaOS/eliza", () => {
    expect(DEFAULT_BRANDING.orgName).toBe("elizaos");
    expect(DEFAULT_BRANDING.repoName).toBe("eliza");
    expect(DEFAULT_BRANDING.packageScope).toBe("elizaos");
  });

  it("derives docs and app URLs from the shared brand constants", () => {
    expect(DEFAULT_BRANDING.docsUrl).toBe(EXTERNAL_URLS.docs);
    expect(DEFAULT_BRANDING.appUrl).toBe(EXTERNAL_URLS.app);
    expect(DEFAULT_BRANDING.docsUrl).toMatch(/^https:\/\//);
    expect(DEFAULT_BRANDING.appUrl).toMatch(/^https:\/\//);
  });

  it("links bug reports to the elizaOS/eliza issue template", () => {
    expect(DEFAULT_BRANDING.bugReportUrl).toBe(
      "https://github.com/elizaos/eliza/issues/new?template=bug_report.yml",
    );
  });

  it("keeps the agent-facing hashtag and file extension stable", () => {
    expect(DEFAULT_BRANDING.hashtag).toBe("#ElizaAgent");
    expect(DEFAULT_BRANDING.fileExtension).toBe(".eliza-agent");
  });

  it("leaves every optional extension point unset so apps opt in explicitly", () => {
    expect(DEFAULT_BRANDING.customProviders).toBeUndefined();
    expect(DEFAULT_BRANDING.firstRunTheme).toBeUndefined();
    expect(DEFAULT_BRANDING.theme).toBeUndefined();
    expect(DEFAULT_BRANDING.cloudOnly).toBeUndefined();
  });
});

describe("appNameInterpolationVars", () => {
  it("passes a plain configured name through unchanged", () => {
    const vars = appNameInterpolationVars({
      ...DEFAULT_BRANDING,
      appName: "Nexa",
    });
    expect(vars).toEqual({ appName: "Nexa" });
  });

  it("returns exactly one key so t() interpolation gets a tight var bag", () => {
    const vars = appNameInterpolationVars(DEFAULT_BRANDING);
    expect(Object.keys(vars)).toEqual(["appName"]);
  });

  it("trims surrounding whitespace from a configured name", () => {
    const vars = appNameInterpolationVars({
      ...DEFAULT_BRANDING,
      appName: "  Nexa  ",
    });
    expect(vars).toEqual({ appName: "Nexa" });
  });

  it("falls back to the Eliza display name for an empty string", () => {
    const vars = appNameInterpolationVars({
      ...DEFAULT_BRANDING,
      appName: "",
    });
    expect(vars.appName).toBe(DEFAULT_APP_DISPLAY_NAME);
  });

  it("falls back to the Eliza display name for a whitespace-only name", () => {
    const vars = appNameInterpolationVars({
      ...DEFAULT_BRANDING,
      appName: "   ",
    });
    expect(vars.appName).toBe(DEFAULT_APP_DISPLAY_NAME);
  });

  it("survives a branding object whose appName field is missing (defensive optional chain)", () => {
    // The helper reads branding.appName?.trim(), so a partially-built
    // branding object must degrade to the default rather than crash or
    // interpolate "undefined" into i18n copy.
    const withoutName: BrandingConfig = { ...DEFAULT_BRANDING };
    delete (withoutName as Partial<BrandingConfig>).appName;
    const vars = appNameInterpolationVars(withoutName);
    expect(vars).toEqual({ appName: DEFAULT_APP_DISPLAY_NAME });
  });
});
