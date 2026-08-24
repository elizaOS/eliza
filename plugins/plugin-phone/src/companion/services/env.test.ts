/**
 * Unit coverage for phone-companion env accessors.
 *
 * Behavioral risk: these values gate UI behavior (agent URL used for
 * outbound requests, APNs enablement, dev-mode styling). Missing or empty
 * config must map to explicit null/false rather than throwing or leaking
 * whitespace-padded URLs into the fetch layer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentUrl, apnsEnabled, isDev } from "./env.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agentUrl", () => {
  it("returns null when the env var is absent", () => {
    vi.stubEnv("VITE_ELIZA_AGENT_URL", undefined);
    expect(agentUrl()).toBeNull();
  });

  it("returns null for a whitespace-only value", () => {
    vi.stubEnv("VITE_ELIZA_AGENT_URL", "   ");
    expect(agentUrl()).toBeNull();
  });

  it("returns the trimmed URL", () => {
    vi.stubEnv("VITE_ELIZA_AGENT_URL", "  https://agent.example.com  ");
    expect(agentUrl()).toBe("https://agent.example.com");
  });

  it("returns the raw value unchanged when no padding", () => {
    vi.stubEnv("VITE_ELIZA_AGENT_URL", "http://localhost:3000");
    expect(agentUrl()).toBe("http://localhost:3000");
  });
});

describe("apnsEnabled", () => {
  it("returns false when absent", () => {
    vi.stubEnv("VITE_ELIZA_APNS_ENABLED", undefined);
    expect(apnsEnabled()).toBe(false);
  });

  it("returns true only for the literal '1'", () => {
    vi.stubEnv("VITE_ELIZA_APNS_ENABLED", "1");
    expect(apnsEnabled()).toBe(true);
  });

  it("returns false for any other value", () => {
    for (const v of ["0", "true", "yes", "on", " 1 ", "2"]) {
      vi.stubEnv("VITE_ELIZA_APNS_ENABLED", v);
      expect(apnsEnabled()).toBe(false);
    }
  });
});

describe("isDev", () => {
  it("returns true when MODE is absent", () => {
    vi.stubEnv("MODE", undefined);
    expect(isDev()).toBe(true);
  });

  it("returns false in production", () => {
    vi.stubEnv("MODE", "production");
    expect(isDev()).toBe(false);
  });

  it("returns true for any non-production MODE", () => {
    for (const v of ["development", "test", "staging", ""]) {
      vi.stubEnv("MODE", v);
      expect(isDev()).toBe(true);
    }
  });
});
