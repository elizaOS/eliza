import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "./config.js";

function makeSetting(overrides: Record<string, string | null> = {}) {
  return (key: string): string | boolean | number | null => {
    if (key in overrides) return overrides[key] as string | null;
    return null;
  };
}

describe("loadConfig", () => {
  it("returns defaults when no settings are provided", () => {
    const config = loadConfig(makeSetting());
    expect(config.apiUrl).toBe(DEFAULT_CONFIG.apiUrl);
    expect(config.apiKey).toBe(DEFAULT_CONFIG.apiKey);
    expect(config.minServiceScore).toBe(DEFAULT_CONFIG.minServiceScore);
    expect(config.autoRejectFlags).toEqual(DEFAULT_CONFIG.autoRejectFlags);
    expect(config.cacheTtl).toBe(DEFAULT_CONFIG.cacheTtl);
    expect(config.watchedDomains).toEqual([]);
    expect(config.watchInterval).toBe(DEFAULT_CONFIG.watchInterval);
  });

  it("overrides with custom settings", () => {
    const config = loadConfig(makeSetting({
      SCOUT_API_URL: "https://custom.api.com",
      SCOUT_API_KEY: "sk-test-123",
      SCOUT_MIN_SERVICE_SCORE: "70",
      SCOUT_CACHE_TTL: "15",
      SCOUT_WATCHED_DOMAINS: "foo.com,bar.io",
      SCOUT_WATCH_INTERVAL: "30",
    }));
    expect(config.apiUrl).toBe("https://custom.api.com");
    expect(config.apiKey).toBe("sk-test-123");
    expect(config.minServiceScore).toBe(70);
    expect(config.cacheTtl).toBe(15);
    expect(config.watchedDomains).toEqual(["foo.com", "bar.io"]);
    expect(config.watchInterval).toBe(30);
  });

  it("throws for non-HTTPS API URL", () => {
    expect(() =>
      loadConfig(makeSetting({ SCOUT_API_URL: "http://insecure.com" }))
    ).toThrow("SCOUT_API_URL must use HTTPS");
  });

  it("allows HTTPS API URL", () => {
    const config = loadConfig(makeSetting({ SCOUT_API_URL: "https://secure.com" }));
    expect(config.apiUrl).toBe("https://secure.com");
  });

  it("preserves valid 0 for minServiceScore", () => {
    const config = loadConfig(makeSetting({ SCOUT_MIN_SERVICE_SCORE: "0" }));
    expect(config.minServiceScore).toBe(0);
  });

  it("preserves valid 0 for cacheTtl", () => {
    const config = loadConfig(makeSetting({ SCOUT_CACHE_TTL: "0" }));
    expect(config.cacheTtl).toBe(0);
  });

  it("enforces minimum watchInterval of 1", () => {
    const config = loadConfig(makeSetting({ SCOUT_WATCH_INTERVAL: "0" }));
    expect(config.watchInterval).toBe(1);
  });

  it("enforces minimum watchInterval for negative values", () => {
    const config = loadConfig(makeSetting({ SCOUT_WATCH_INTERVAL: "-5" }));
    expect(config.watchInterval).toBe(1);
  });

  it("uses defaults for non-numeric values", () => {
    const config = loadConfig(makeSetting({
      SCOUT_MIN_SERVICE_SCORE: "abc",
      SCOUT_CACHE_TTL: "not-a-number",
    }));
    expect(config.minServiceScore).toBe(DEFAULT_CONFIG.minServiceScore);
    expect(config.cacheTtl).toBe(DEFAULT_CONFIG.cacheTtl);
  });

  it("parses custom auto-reject flags", () => {
    const config = loadConfig(makeSetting({
      SCOUT_AUTO_REJECT_FLAGS: "FLAG_A, FLAG_B , FLAG_C",
    }));
    expect(config.autoRejectFlags).toEqual(["FLAG_A", "FLAG_B", "FLAG_C"]);
  });

  it("uses default flags when auto-reject is whitespace only", () => {
    const config = loadConfig(makeSetting({
      SCOUT_AUTO_REJECT_FLAGS: "  ",
    }));
    expect(config.autoRejectFlags).toEqual(DEFAULT_CONFIG.autoRejectFlags);
  });

  it("trims watched domain names", () => {
    const config = loadConfig(makeSetting({
      SCOUT_WATCHED_DOMAINS: " foo.com , bar.io ",
    }));
    expect(config.watchedDomains).toEqual(["foo.com", "bar.io"]);
  });

  it("handles getSetting returning boolean", () => {
    const config = loadConfig((key) => {
      if (key === "SCOUT_API_KEY") return true;
      return null;
    });
    expect(config.apiKey).toBe("true");
  });

  it("handles getSetting returning number", () => {
    const config = loadConfig((key) => {
      if (key === "SCOUT_MIN_SERVICE_SCORE") return 42;
      return null;
    });
    expect(config.minServiceScore).toBe(42);
  });
});