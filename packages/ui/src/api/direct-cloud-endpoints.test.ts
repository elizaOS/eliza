/**
 * Unit coverage for the direct Cloud endpoint resolvers: the environment
 * constants, the exported API host map, trailing-slash stripping, the
 * environment-pairing rule, and each resolver's fallback contract
 * (unknown-host preserving vs. canonicalizing, malformed-input pass-through).
 * Pure deterministic harness over the real module — no mocks, no network.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  DEFAULT_DIRECT_CLOUD_APP_BASE_URL,
  DEFAULT_DIRECT_CLOUD_BASE_URL,
  DIRECT_ELIZA_CLOUD_API_BY_HOST,
  directCloudAppBaseForApi,
  resolveCanonicalDirectCloudApiBase,
  resolveDirectCloudAppBase,
  resolveDirectCloudAuthApiBase,
  resolveDirectCloudWebBase,
  STAGING_DIRECT_CLOUD_API_BASE_URL,
  STAGING_DIRECT_CLOUD_APP_BASE_URL,
  STAGING_DIRECT_CLOUD_BASE_URL,
  stripTrailingSlashes,
} from "./direct-cloud-endpoints";

describe("direct cloud endpoint constants", () => {
  it("pins the production origins to the eliza.app contract", () => {
    expect(DEFAULT_DIRECT_CLOUD_BASE_URL).toBe("https://eliza.app");
    expect(DEFAULT_DIRECT_CLOUD_APP_BASE_URL).toBe("https://cloud.eliza.app");
    expect(DEFAULT_DIRECT_CLOUD_API_BASE_URL).toBe("https://api.eliza.app");
  });

  it("pins the staging origins to the staging contract", () => {
    expect(STAGING_DIRECT_CLOUD_BASE_URL).toBe("https://staging.eliza.app");
    expect(STAGING_DIRECT_CLOUD_APP_BASE_URL).toBe(
      "https://cloud-staging.eliza.app",
    );
    expect(STAGING_DIRECT_CLOUD_API_BASE_URL).toBe(
      "https://api-staging.eliza.app",
    );
  });
});

describe("stripTrailingSlashes", () => {
  it("returns values without a trailing slash unchanged", () => {
    expect(stripTrailingSlashes("https://api.eliza.app")).toBe(
      "https://api.eliza.app",
    );
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("/")).toBe("");
  });

  it("removes an entire trailing slash run in one scan", () => {
    expect(stripTrailingSlashes("https://api.eliza.app/")).toBe(
      "https://api.eliza.app",
    );
    expect(stripTrailingSlashes("https://api.eliza.app///")).toBe(
      "https://api.eliza.app",
    );
  });

  it("keeps interior slashes intact", () => {
    expect(stripTrailingSlashes("https://eliza.app/cloud/api-keys//")).toBe(
      "https://eliza.app/cloud/api-keys",
    );
  });
});

describe("DIRECT_ELIZA_CLOUD_API_BY_HOST", () => {
  it("is a Map routing every canonical host to its environment's API origin", () => {
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST).toBeInstanceOf(Map);
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get("api.eliza.app")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get("eliza.app")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get("cloud.eliza.app")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get("api-staging.eliza.app")).toBe(
      STAGING_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get("staging.eliza.app")).toBe(
      STAGING_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get("cloud-staging.eliza.app")).toBe(
      STAGING_DIRECT_CLOUD_API_BASE_URL,
    );
  });

  it("classifies every retired elizacloud.ai host into its environment", () => {
    const productionLegacyHosts = [
      "elizacloud.ai",
      "www.elizacloud.ai",
      "dev.elizacloud.ai",
      "b.eliza.app",
      "eliza-app-b.pages.dev",
      "app.elizacloud.ai",
      "api.elizacloud.ai",
    ];
    for (const hostname of productionLegacyHosts) {
      expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get(hostname)).toBe(
        DEFAULT_DIRECT_CLOUD_API_BASE_URL,
      );
    }
    for (const hostname of [
      "staging.elizacloud.ai",
      "app-staging.elizacloud.ai",
      "api-staging.elizacloud.ai",
    ]) {
      expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get(hostname)).toBe(
        STAGING_DIRECT_CLOUD_API_BASE_URL,
      );
    }
  });

  it("reports unknown hosts as absent rather than guessing", () => {
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.has("example.com")).toBe(false);
    expect(DIRECT_ELIZA_CLOUD_API_BY_HOST.get("example.com")).toBeUndefined();
  });
});

describe("directCloudAppBaseForApi", () => {
  it("pairs the production API origin with the production app origin", () => {
    expect(directCloudAppBaseForApi(DEFAULT_DIRECT_CLOUD_API_BASE_URL)).toBe(
      DEFAULT_DIRECT_CLOUD_APP_BASE_URL,
    );
  });

  it("pairs the staging API origin with the staging app origin so sessions stay claimable", () => {
    expect(directCloudAppBaseForApi(STAGING_DIRECT_CLOUD_API_BASE_URL)).toBe(
      STAGING_DIRECT_CLOUD_APP_BASE_URL,
    );
  });

  it("falls back to the production app origin for anything else", () => {
    expect(directCloudAppBaseForApi(DEFAULT_DIRECT_CLOUD_BASE_URL)).toBe(
      DEFAULT_DIRECT_CLOUD_APP_BASE_URL,
    );
    expect(directCloudAppBaseForApi("https://owner-selected.example")).toBe(
      DEFAULT_DIRECT_CLOUD_APP_BASE_URL,
    );
  });

  it("matches the staging API origin by exact equality only", () => {
    expect(
      directCloudAppBaseForApi(`${STAGING_DIRECT_CLOUD_API_BASE_URL}/`),
    ).toBe(DEFAULT_DIRECT_CLOUD_APP_BASE_URL);
  });
});

describe.each([
  ["resolveDirectCloudWebBase", resolveDirectCloudWebBase],
  ["resolveDirectCloudAppBase", resolveDirectCloudAppBase],
  ["resolveDirectCloudAuthApiBase", resolveDirectCloudAuthApiBase],
] as const)("%s", (_name, resolve) => {
  it("maps canonical and legacy production hosts to the production origin", () => {
    expect(resolve("https://api.eliza.app")).toBe(
      resolve === resolveDirectCloudWebBase
        ? DEFAULT_DIRECT_CLOUD_BASE_URL
        : resolve === resolveDirectCloudAppBase
          ? DEFAULT_DIRECT_CLOUD_APP_BASE_URL
          : DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(resolve("https://www.elizacloud.ai/")).toBe(
      resolve === resolveDirectCloudWebBase
        ? DEFAULT_DIRECT_CLOUD_BASE_URL
        : resolve === resolveDirectCloudAppBase
          ? DEFAULT_DIRECT_CLOUD_APP_BASE_URL
          : DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
  });

  it("maps canonical and legacy staging hosts to the staging origin", () => {
    expect(resolve("https://staging.eliza.app/")).toBe(
      resolve === resolveDirectCloudWebBase
        ? STAGING_DIRECT_CLOUD_BASE_URL
        : resolve === resolveDirectCloudAppBase
          ? STAGING_DIRECT_CLOUD_APP_BASE_URL
          : STAGING_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(resolve("https://staging.elizacloud.ai")).toBe(
      resolve === resolveDirectCloudWebBase
        ? STAGING_DIRECT_CLOUD_BASE_URL
        : resolve === resolveDirectCloudAppBase
          ? STAGING_DIRECT_CLOUD_APP_BASE_URL
          : STAGING_DIRECT_CLOUD_API_BASE_URL,
    );
  });

  it("matches hostnames case-insensitively", () => {
    expect(resolve("https://API.ELIZA.APP")).toBe(
      resolve === resolveDirectCloudWebBase
        ? DEFAULT_DIRECT_CLOUD_BASE_URL
        : resolve === resolveDirectCloudAppBase
          ? DEFAULT_DIRECT_CLOUD_APP_BASE_URL
          : DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(resolve("https://APP-STAGING.ELIZACLOUD.AI")).toBe(
      resolve === resolveDirectCloudWebBase
        ? STAGING_DIRECT_CLOUD_BASE_URL
        : resolve === resolveDirectCloudAppBase
          ? STAGING_DIRECT_CLOUD_APP_BASE_URL
          : STAGING_DIRECT_CLOUD_API_BASE_URL,
    );
  });

  it("preserves an unconfigured origin after stripping its trailing slash run", () => {
    expect(resolve("https://owner-configured.example/base///")).toBe(
      "https://owner-configured.example/base",
    );
  });

  it("leaves malformed configured URLs explicitly unchanged", () => {
    expect(resolve("not-a-url")).toBe("not-a-url");
    expect(resolve("")).toBe("");
  });
});

describe("resolveCanonicalDirectCloudApiBase", () => {
  it("defaults absent configuration to the production API origin", () => {
    expect(resolveCanonicalDirectCloudApiBase(null)).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(resolveCanonicalDirectCloudApiBase(undefined)).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(resolveCanonicalDirectCloudApiBase("")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(resolveCanonicalDirectCloudApiBase("   ")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
  });

  it("resolves configured canonical and legacy hosts to their API origin", () => {
    expect(resolveCanonicalDirectCloudApiBase("https://api.eliza.app///")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(
      resolveCanonicalDirectCloudApiBase("https://api.elizacloud.ai"),
    ).toBe(DEFAULT_DIRECT_CLOUD_API_BASE_URL);
    expect(
      resolveCanonicalDirectCloudApiBase(" https://api-staging.eliza.app/ "),
    ).toBe(STAGING_DIRECT_CLOUD_API_BASE_URL);
    expect(
      resolveCanonicalDirectCloudApiBase("https://app-staging.elizacloud.ai"),
    ).toBe(STAGING_DIRECT_CLOUD_API_BASE_URL);
  });

  it("never preserves an unrecognized or malformed authority", () => {
    expect(
      resolveCanonicalDirectCloudApiBase("https://owner.example/store"),
    ).toBe(DEFAULT_DIRECT_CLOUD_API_BASE_URL);
    expect(resolveCanonicalDirectCloudApiBase("garbage://")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
    expect(resolveCanonicalDirectCloudApiBase("not-a-url")).toBe(
      DEFAULT_DIRECT_CLOUD_API_BASE_URL,
    );
  });
});
