/**
 * Unit tests for config normalization and trusted API-discovery candidate
 * ordering; pure functions, no chrome.storage.
 */
import { describe, expect, it } from "vitest";
import {
  candidateApiBaseUrlsFromTabs,
  DEFAULT_BROWSER_BRIDGE_API_BASE_URL,
  getOrCreateExtensionProfileId,
  isValidApiBaseUrl,
  normalizeCompanionConfig,
  resolveTrustedBlockedPageApiBase,
} from "./storage";

describe("candidateApiBaseUrlsFromTabs", () => {
  it("deduplicates loopback origins and excludes remote app tabs", () => {
    expect(
      candidateApiBaseUrlsFromTabs([
        { title: "Eliza", url: "https://eliza.dev" },
        { title: "LifeOps", url: "https://eliza.dev/settings" },
        { title: "Other", url: "http://127.0.0.1:31337" },
      ]),
    ).toEqual(["http://127.0.0.1:31337"]);
  });

  it("rejects title-spoofed remote, plaintext remote, credentialed, and subdomain candidates", () => {
    expect(
      candidateApiBaseUrlsFromTabs([
        { title: "Eliza", url: "javascript:alert(1)" },
        { title: "Eliza", url: "https://user:pass@example.com/app" },
        { title: "Eliza LifeOps", url: "https://attacker.example/app" },
        { title: "Eliza", url: "http://eliza.dev/app" },
        { title: "Eliza", url: "https://app.eliza.dev/app" },
        { title: "Eliza", url: "http://127.0.0.1.attacker.example/app" },
        { title: "Other", url: "http://[::1]:2138/settings" },
        { title: "Other", url: "file:///tmp/index.html" },
      ]),
    ).toEqual(["http://[::1]:2138"]);
  });
});

describe("getOrCreateExtensionProfileId", () => {
  function profileStore(initial: string | null = null) {
    let value: string | null = initial;
    return {
      get: async () => value,
      set: async (next: string) => {
        value = next;
      },
    };
  }

  it("is stable across reloads and unique for separate extension profiles", async () => {
    const firstStore = profileStore();
    const secondStore = profileStore();
    const first = await getOrCreateExtensionProfileId(firstStore);
    expect(await getOrCreateExtensionProfileId(firstStore)).toBe(first);
    expect(await getOrCreateExtensionProfileId(secondStore)).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("migrates prefixed legacy IDs and replaces non-UUID values", async () => {
    const uuid = "018f0000-0000-4000-8000-000000000001";
    const legacy = profileStore(`extension-profile-${uuid}`);
    expect(await getOrCreateExtensionProfileId(legacy)).toBe(uuid);
    expect(await legacy.get()).toBe(uuid);

    const invalid = profileStore("manual-profile-name");
    const replacement = await getOrCreateExtensionProfileId(invalid);
    expect(replacement).not.toBe("manual-profile-name");
    expect(replacement).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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

  it("rejects hostile API bases and invalid browser names", () => {
    for (const apiBaseUrl of [
      "javascript:alert(1)",
      "file:///tmp/socket",
      "https://user:pass@agent.example.com",
      "http://agent.example.com",
      "http://127.0.0.1.attacker.example",
      "not a url",
    ]) {
      expect(
        normalizeCompanionConfig({ ...baseConfig, apiBaseUrl }),
      ).toBeNull();
      expect(isValidApiBaseUrl(apiBaseUrl)).toBe(false);
    }

    expect(
      normalizeCompanionConfig({ ...baseConfig, browser: "firefox" }),
    ).toMatchObject({ browser: "firefox" });
    expect(
      normalizeCompanionConfig({ ...baseConfig, browser: "netscape" }),
    ).toBeNull();
  });

  it("uses the loopback default for blank API base URLs", () => {
    expect(
      normalizeCompanionConfig({ ...baseConfig, apiBaseUrl: "   " })
        ?.apiBaseUrl,
    ).toBe(DEFAULT_BROWSER_BRIDGE_API_BASE_URL);
  });
});

describe("resolveTrustedBlockedPageApiBase", () => {
  const paired = normalizeCompanionConfig({
    apiBaseUrl: "http://127.0.0.1:31337",
    companionId: "companion-1",
    pairingToken: "token-1",
    browser: "chrome",
    profileId: "default",
    profileLabel: "Default",
  });

  it("accepts only the exact persisted companion origin", () => {
    expect(
      resolveTrustedBlockedPageApiBase("http://127.0.0.1:31337", paired),
    ).toBe("http://127.0.0.1:31337");
    expect(
      resolveTrustedBlockedPageApiBase("https://attacker.example", paired),
    ).toBeNull();
    expect(
      resolveTrustedBlockedPageApiBase("http://localhost:31337", paired),
    ).toBeNull();
    expect(
      resolveTrustedBlockedPageApiBase("http://127.0.0.1:31337", null),
    ).toBeNull();
  });
});
