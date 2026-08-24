/**
 * Deterministically verifies that public homepage navigation stays within the
 * environment selected by canonical and legacy browser hostnames.
 */

import { describe, expect, test } from "bun:test";
import { resolveHomepageProductNavigation } from "../src/lib/product-navigation";

describe("homepage product navigation", () => {
  test("routes the production homepage to the production Cloud app", () => {
    expect(resolveHomepageProductNavigation("eliza.app")).toEqual({
      signInUrl: "https://cloud.eliza.app/login?intent=launch",
      dashboardUrl: "https://cloud.eliza.app/cloud-apps",
    });
  });

  test("routes the staging homepage to the staging Cloud app", () => {
    expect(resolveHomepageProductNavigation("staging.eliza.app")).toEqual({
      signInUrl: "https://cloud-staging.eliza.app/login?intent=launch",
      dashboardUrl: "https://cloud-staging.eliza.app/cloud-apps",
    });
  });

  test("preserves staging for the legacy staging hostname", () => {
    expect(resolveHomepageProductNavigation("staging.elizacloud.ai")).toEqual({
      signInUrl: "https://cloud-staging.eliza.app/login?intent=launch",
      dashboardUrl: "https://cloud-staging.eliza.app/cloud-apps",
    });
  });

  test("defaults unknown and local hosts to production rather than trusting them", () => {
    for (const hostname of ["localhost", "preview.example.com", ""]) {
      expect(resolveHomepageProductNavigation(hostname)).toEqual({
        signInUrl: "https://cloud.eliza.app/login?intent=launch",
        dashboardUrl: "https://cloud.eliza.app/cloud-apps",
      });
    }
  });

  test("routes retired production elizacloud.ai hosts to the canonical production Cloud app", () => {
    for (const hostname of [
      "elizacloud.ai",
      "www.elizacloud.ai",
      "dev.elizacloud.ai",
      "app.elizacloud.ai",
      "api.elizacloud.ai",
      "b.eliza.app",
      "eliza-app-b.pages.dev",
    ]) {
      expect(resolveHomepageProductNavigation(hostname)).toEqual({
        signInUrl: "https://cloud.eliza.app/login?intent=launch",
        dashboardUrl: "https://cloud.eliza.app/cloud-apps",
      });
    }
  });

  test("keeps canonical staging Cloud control-plane and dedicated-agent hosts on staging", () => {
    for (const hostname of [
      "cloud-staging.eliza.app",
      "api-staging.eliza.app",
      "team-a.cloud-staging.eliza.app",
    ]) {
      expect(resolveHomepageProductNavigation(hostname)).toEqual({
        signInUrl: "https://cloud-staging.eliza.app/login?intent=launch",
        dashboardUrl: "https://cloud-staging.eliza.app/cloud-apps",
      });
    }
  });

  test("keeps production Cloud app and dedicated-agent hosts on production", () => {
    for (const hostname of ["cloud.eliza.app", "solo.cloud.eliza.app"]) {
      expect(resolveHomepageProductNavigation(hostname)).toEqual({
        signInUrl: "https://cloud.eliza.app/login?intent=launch",
        dashboardUrl: "https://cloud.eliza.app/cloud-apps",
      });
    }
  });

  test("classifies hostnames case-insensitively after trimming whitespace and trailing dots", () => {
    for (const [hostname, cloudAppOrigin] of [
      [" ELIZA.App ", "https://cloud.eliza.app"],
      ["eliza.app.", "https://cloud.eliza.app"],
      ["WWW.ELIZA.APP", "https://cloud.eliza.app"],
      ["Staging.ElizaCloud.AI.", "https://cloud-staging.eliza.app"],
    ] as const) {
      expect(resolveHomepageProductNavigation(hostname)).toEqual({
        signInUrl: `${cloudAppOrigin}/login?intent=launch`,
        dashboardUrl: `${cloudAppOrigin}/cloud-apps`,
      });
    }
  });
});
