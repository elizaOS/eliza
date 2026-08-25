/**
 * Behavior coverage for SEO environment helpers.
 *
 * Indexability is controlled by the configured app host versus the
 * NEXT_PUBLIC_INDEXABLE_HOSTS allowlist (default: eliza.app / www.eliza.app).
 * Host comparison is normalized (trim + lowercase), and robots output must
 * mirror the index decision across every field so search crawlers never see
 * a mixed index/no-index signal.
 */
import { describe, expect, test } from "bun:test";
import {
  generateRobotsFile,
  getIndexableHosts,
  getRobotsMetadata,
  shouldIndexSite,
} from "./environment";

const INDEXABLE_ENV = { NEXT_PUBLIC_APP_URL: "https://eliza.app" } as const;

describe("getIndexableHosts", () => {
  test("defaults to eliza.app and www.eliza.app when unset", () => {
    expect(getIndexableHosts({})).toEqual(["eliza.app", "www.eliza.app"]);
  });

  test("reads the configured allowlist", () => {
    expect(getIndexableHosts({ NEXT_PUBLIC_INDEXABLE_HOSTS: "example.com,other.org" })).toEqual([
      "example.com",
      "other.org",
    ]);
  });

  test("normalizes host casing and trims whitespace", () => {
    expect(getIndexableHosts({ NEXT_PUBLIC_INDEXABLE_HOSTS: "  Example.COM , " })).toEqual([
      "example.com",
    ]);
  });

  test("falls back to defaults when the allowlist is only empty entries", () => {
    expect(getIndexableHosts({ NEXT_PUBLIC_INDEXABLE_HOSTS: " , " })).toEqual([
      "eliza.app",
      "www.eliza.app",
    ]);
  });
});

describe("shouldIndexSite", () => {
  test("indexes the default app host", () => {
    expect(shouldIndexSite(INDEXABLE_ENV as NodeJS.ProcessEnv)).toBe(true);
  });

  test("does not index a non-allowlisted host", () => {
    expect(
      shouldIndexSite({ NEXT_PUBLIC_APP_URL: "https://evil.example.com" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  test("indexes a www subdomain of an allowlisted host", () => {
    expect(
      shouldIndexSite({ NEXT_PUBLIC_APP_URL: "https://www.eliza.app" } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  test("matches hosts case-insensitively", () => {
    expect(shouldIndexSite({ NEXT_PUBLIC_APP_URL: "https://ELIZA.APP" } as NodeJS.ProcessEnv)).toBe(
      true,
    );
  });
});

describe("getRobotsMetadata", () => {
  test("returns indexable metadata on an allowlisted host", () => {
    const metadata = getRobotsMetadata({}, INDEXABLE_ENV as NodeJS.ProcessEnv);
    expect(metadata).toEqual({
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-video-preview": -1,
        "max-image-preview": "large",
        "max-snippet": -1,
      },
    });
  });

  test("returns noindex metadata when noIndex is requested", () => {
    const metadata = getRobotsMetadata({ noIndex: true }, INDEXABLE_ENV as NodeJS.ProcessEnv);
    expect(metadata).toEqual({
      index: false,
      follow: false,
      googleBot: {
        index: false,
        follow: false,
        "max-video-preview": 0,
        "max-image-preview": "none",
        "max-snippet": 0,
      },
    });
  });

  test("returns noindex metadata on a non-allowlisted host", () => {
    const metadata = getRobotsMetadata({}, {
      NEXT_PUBLIC_APP_URL: "https://evil.example.com",
    } as NodeJS.ProcessEnv);
    expect(metadata?.index).toBe(false);
    expect(metadata?.googleBot?.["max-image-preview"]).toBe("none");
  });
});

describe("generateRobotsFile", () => {
  test("allows crawling and emits a sitemap when indexable", () => {
    const robots = generateRobotsFile(INDEXABLE_ENV as NodeJS.ProcessEnv);
    expect(robots).toEqual({
      rules: { userAgent: "*", allow: "/" },
      host: "https://eliza.app",
      sitemap: "https://eliza.app/sitemap.xml",
    });
  });

  test("disallows crawling and omits the sitemap when not indexable", () => {
    const robots = generateRobotsFile({ NEXT_PUBLIC_APP_URL: "https://x.io" } as NodeJS.ProcessEnv);
    expect(robots).toEqual({
      rules: { userAgent: "*", disallow: "/" },
      host: "https://x.io",
      sitemap: undefined,
    });
  });
});
