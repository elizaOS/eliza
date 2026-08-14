/**
 * Deterministically verifies that public homepage navigation stays within the
 * environment selected by canonical and legacy browser hostnames.
 */

import { describe, expect, test } from "bun:test";
import { resolveHomepageProductNavigation } from "../src/lib/product-navigation";

describe("homepage product navigation", () => {
  test("routes the production homepage to the production Cloud app", () => {
    expect(resolveHomepageProductNavigation("eliza.app")).toEqual({
      signInUrl: "https://cloud.eliza.app/login?returnTo=%2Fcloud",
      dashboardUrl: "https://cloud.eliza.app/cloud",
    });
  });

  test("routes the staging homepage to the staging Cloud app", () => {
    expect(resolveHomepageProductNavigation("staging.eliza.app")).toEqual({
      signInUrl: "https://cloud-staging.eliza.app/login?returnTo=%2Fcloud",
      dashboardUrl: "https://cloud-staging.eliza.app/cloud",
    });
  });

  test("preserves staging for the legacy staging hostname", () => {
    expect(resolveHomepageProductNavigation("staging.elizacloud.ai")).toEqual({
      signInUrl: "https://cloud-staging.eliza.app/login?returnTo=%2Fcloud",
      dashboardUrl: "https://cloud-staging.eliza.app/cloud",
    });
  });

  test("defaults unknown and local hosts to production rather than trusting them", () => {
    for (const hostname of ["localhost", "preview.example.com", ""]) {
      expect(resolveHomepageProductNavigation(hostname)).toEqual({
        signInUrl: "https://cloud.eliza.app/login?returnTo=%2Fcloud",
        dashboardUrl: "https://cloud.eliza.app/cloud",
      });
    }
  });
});
