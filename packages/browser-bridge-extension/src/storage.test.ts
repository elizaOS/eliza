/**
 * Unit tests for config normalization and loopback API-discovery candidate
 * ordering; pure functions, no chrome.storage.
 */
import { describe, expect, it } from "vitest";
import {
  candidateApiBaseUrlsFromTabs,
  DEFAULT_BROWSER_BRIDGE_API_BASE_URL,
  isValidApiBaseUrl,
  normalizeAutoPairCompanionConfig,
  normalizeCompanionConfig,
} from "./storage";

describe("candidateApiBaseUrlsFromTabs", () => {
  it("deduplicates likely Eliza tabs before loopback fallbacks", () => {
    expect(
      candidateApiBaseUrlsFromTabs([
        { title: "Eliza", url: "http://localhost:3000" },
        { title: "LifeOps", url: "http://localhost:3000/settings" },
        { title: "Other", url: "http://127.0.0.1:31337" },
      ]),
    ).toEqual(["http://localhost:3000", "http://127.0.0.1:31337"]);
  });

  it("ignores invalid, credentialed, and non-http tab URLs while preserving safe loopback origins", () => {
    expect(
      candidateApiBaseUrlsFromTabs([
        { title: "Eliza", url: "javascript:alert(1)" },
        { title: "Eliza", url: "https://user:pass@example.com/app" },
        { title: "Other", url: "http://[::1]:2138/settings" },
        { title: "Other", url: "file:///tmp/index.html" },
      ]),
    ).toEqual(["https://example.com", "http://[::1]:2138"]);
  });
});

describe("normalizeCompanionConfig", () => {
  const baseConfig = {
    apiBaseUrl: "https://agent.example.com/api?debug=true#section",
    companionId: " companion-1 ",
    pairingToken: " token-1 ",
    browser: "chrome",
    profileId: " profile ",
    profileLabel: " Work ",
  };

  it("normalizes safe config fields and strips URL query/fragment", () => {
    expect(normalizeCompanionConfig(baseConfig)).toMatchObject({
      apiBaseUrl: "https://agent.example.com/api",
      companionId: "companion-1",
      pairingToken: "token-1",
      browser: "chrome",
      profileId: "profile",
      profileLabel: "Work",
    });
  });

  it("accepts Firefox and rejects hostile API bases and invalid browser names", () => {
    expect(
      normalizeCompanionConfig({ ...baseConfig, browser: "firefox" }),
    ).toMatchObject({ browser: "firefox" });

    for (const apiBaseUrl of [
      "javascript:alert(1)",
      "file:///tmp/socket",
      "https://user:pass@agent.example.com",
      "not a url",
    ]) {
      expect(
        normalizeCompanionConfig({ ...baseConfig, apiBaseUrl }),
      ).toBeNull();
      expect(isValidApiBaseUrl(apiBaseUrl)).toBe(false);
    }

    expect(
      normalizeCompanionConfig({ ...baseConfig, browser: "edge" }),
    ).toBeNull();
  });

  it("uses the loopback default for blank API base URLs", () => {
    expect(
      normalizeCompanionConfig({ ...baseConfig, apiBaseUrl: "   " })
        ?.apiBaseUrl,
    ).toBe(DEFAULT_BROWSER_BRIDGE_API_BASE_URL);
  });
});

describe("normalizeAutoPairCompanionConfig", () => {
  const config = {
    apiBaseUrl: "http://127.0.0.1:31337",
    companionId: "companion-1",
    pairingToken: "token-1",
    browser: "firefox" as const,
  };

  it("binds the returned token to the requested API, browser, and companion", () => {
    expect(
      normalizeAutoPairCompanionConfig(config, {
        apiBaseUrl: config.apiBaseUrl,
        browser: "firefox",
        companionId: config.companionId,
      }),
    ).toMatchObject(config);

    expect(
      normalizeAutoPairCompanionConfig(
        { ...config, apiBaseUrl: "https://attacker.example" },
        {
          apiBaseUrl: config.apiBaseUrl,
          browser: "firefox",
          companionId: config.companionId,
        },
      ),
    ).toBeNull();
    expect(
      normalizeAutoPairCompanionConfig(config, {
        apiBaseUrl: config.apiBaseUrl,
        browser: "chrome",
        companionId: config.companionId,
      }),
    ).toBeNull();
    expect(
      normalizeAutoPairCompanionConfig(config, {
        apiBaseUrl: config.apiBaseUrl,
        browser: "firefox",
        companionId: "other-companion",
      }),
    ).toBeNull();
  });
});
