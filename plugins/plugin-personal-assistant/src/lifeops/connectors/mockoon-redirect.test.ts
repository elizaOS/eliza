/**
 * Unit test for the lifeops Mockoon redirect helper.
 *
 * Materiality: when `LIFEOPS_USE_MOCKOON=1`, connector base URLs are
 * rewritten to local Mockoon ports so tests never hit real Google/OpenAI/
 * Twilio endpoints. A regression here (flag misread, wrong port, or
 * clobbering a caller-supplied override) silently points tests at live
 * services or at the wrong mock. These tests pin the rewrite behaviour.
 */
import { describe, expect, it } from "vitest";
import {
  applyMockoonEnvOverrides,
  getMockoonBaseUrl,
  isMockoonEnabled,
} from "./mockoon-redirect.js";

describe("isMockoonEnabled", () => {
  it("accepts 1/true/yes case-insensitively with surrounding whitespace", () => {
    expect(isMockoonEnabled({ LIFEOPS_USE_MOCKOON: "1" })).toBe(true);
    expect(isMockoonEnabled({ LIFEOPS_USE_MOCKOON: "true" })).toBe(true);
    expect(isMockoonEnabled({ LIFEOPS_USE_MOCKOON: "TRUE" })).toBe(true);
    expect(isMockoonEnabled({ LIFEOPS_USE_MOCKOON: " yes " })).toBe(true);
  });

  it("rejects other values and missing flag", () => {
    expect(isMockoonEnabled({ LIFEOPS_USE_MOCKOON: "0" })).toBe(false);
    expect(isMockoonEnabled({ LIFEOPS_USE_MOCKOON: "false" })).toBe(false);
    expect(isMockoonEnabled({ LIFEOPS_USE_MOCKOON: "2" })).toBe(false);
    expect(isMockoonEnabled({})).toBe(false);
  });
});

describe("getMockoonBaseUrl", () => {
  it("maps connectors to documented local ports", () => {
    expect(getMockoonBaseUrl("gmail")).toBe("http://127.0.0.1:18801");
    expect(getMockoonBaseUrl("calendar")).toBe("http://127.0.0.1:18802");
    expect(getMockoonBaseUrl("slack")).toBe("http://127.0.0.1:18803");
    expect(getMockoonBaseUrl("discord")).toBe("http://127.0.0.1:18804");
    expect(getMockoonBaseUrl("telegram")).toBe("http://127.0.0.1:18805");
    expect(getMockoonBaseUrl("github")).toBe("http://127.0.0.1:18806");
    expect(getMockoonBaseUrl("notion")).toBe("http://127.0.0.1:18807");
    expect(getMockoonBaseUrl("twilio")).toBe("http://127.0.0.1:18808");
    expect(getMockoonBaseUrl("plaid")).toBe("http://127.0.0.1:18809");
    expect(getMockoonBaseUrl("apple-reminders")).toBe("http://127.0.0.1:18810");
    expect(getMockoonBaseUrl("bluebubbles")).toBe("http://127.0.0.1:18811");
    expect(getMockoonBaseUrl("ntfy")).toBe("http://127.0.0.1:18812");
    expect(getMockoonBaseUrl("duffel")).toBe("http://127.0.0.1:18813");
    expect(getMockoonBaseUrl("anthropic")).toBe("http://127.0.0.1:18814");
    expect(getMockoonBaseUrl("cerebras")).toBe("http://127.0.0.1:18815");
    expect(getMockoonBaseUrl("eliza-cloud")).toBe("http://127.0.0.1:18816");
    expect(getMockoonBaseUrl("spotify")).toBe("http://127.0.0.1:18817");
  });
});

describe("applyMockoonEnvOverrides", () => {
  it("mutates nothing and returns [] when mockoon is disabled", () => {
    const env: Record<string, string> = {
      NTFY_BASE_URL: "https://ntfy.example",
    };
    expect(applyMockoonEnvOverrides(env)).toEqual([]);
    expect(env).toEqual({ NTFY_BASE_URL: "https://ntfy.example" });
  });

  it("applies all documented base-URL overrides when enabled", () => {
    const env: Record<string, string> = {};
    const applied = applyMockoonEnvOverrides({
      ...env,
      LIFEOPS_USE_MOCKOON: "1",
    });
    expect(applied.sort()).toEqual([
      "anthropic",
      "calendar",
      "cerebras",
      "duffel",
      "eliza-cloud",
      "gmail",
      "ntfy",
      "plaid",
      "twilio",
    ]);
  });

  it("writes the documented URLs including the google trailing slash", () => {
    const env: Record<string, string> = { LIFEOPS_USE_MOCKOON: "1" };
    applyMockoonEnvOverrides(env);
    expect(env.ELIZA_MOCK_GOOGLE_BASE).toBe("http://127.0.0.1:18801/");
    expect(env.ELIZA_MOCK_TWILIO_BASE).toBe("http://127.0.0.1:18808");
    expect(env.NTFY_BASE_URL).toBe("http://127.0.0.1:18812");
    expect(env.ELIZAOS_CLOUD_BASE_URL).toBe("http://127.0.0.1:18816");
    expect(env.LIFEOPS_DUFFEL_API_BASE).toBe("http://127.0.0.1:18813");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:18814");
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:18815/v1");
  });

  it("never clobbers caller-supplied overrides", () => {
    const env: Record<string, string> = {
      LIFEOPS_USE_MOCKOON: "1",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    };
    applyMockoonEnvOverrides(env);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(env.ELIZA_MOCK_GOOGLE_BASE).toBe("http://127.0.0.1:18801/");
  });

  it("is idempotent on a second call", () => {
    const env: Record<string, string> = { LIFEOPS_USE_MOCKOON: "1" };
    applyMockoonEnvOverrides(env);
    const second = applyMockoonEnvOverrides(env);
    expect(second).toEqual([]);
  });
});
