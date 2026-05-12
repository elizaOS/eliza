import { afterEach, describe, expect, test } from "bun:test";
import { generateRobotsFile, getRobotsMetadata, shouldIndexSite } from "../../lib/seo";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("SEO environment helpers", () => {
  afterEach(() => {
    resetEnv();
  });

  test("keeps the primary Eliza Cloud host indexable", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.elizacloud.ai";

    expect(shouldIndexSite()).toBe(true);
    expect(getRobotsMetadata()).toEqual({
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

  test("marks dev hosts as noindex and blocks crawling", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.dev.elizacloud.ai";

    expect(shouldIndexSite()).toBe(false);
    expect(getRobotsMetadata()).toEqual({
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
    expect(generateRobotsFile()).toEqual({
      rules: {
        userAgent: "*",
        disallow: "/",
      },
      host: "https://www.dev.elizacloud.ai",
      sitemap: undefined,
    });
  });
});
