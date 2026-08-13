/**
 * Tests for `resolveCloudApiBase()` — the web-host → API-host mapping the cloud
 * auth commands use to decide WHICH Eliza Cloud deployment they authenticate
 * against.
 *
 * The environment boundary is the whole point: these cases pin canonical and
 * transitional hosts to their own environment so auth can never cross-wire
 * staging and production.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveCloudApiBase } from "./register.auth";

const ORIGINAL_ENV = process.env.ELIZAOS_CLOUD_BASE_URL;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ELIZAOS_CLOUD_BASE_URL;
  else process.env.ELIZAOS_CLOUD_BASE_URL = ORIGINAL_ENV;
});

describe("resolveCloudApiBase", () => {
  it("maps every production web host to the production API host", () => {
    for (const host of [
      "eliza.app",
      "www.eliza.app",
      "cloud.eliza.app",
      "api.eliza.app",
      "elizacloud.ai",
      "www.elizacloud.ai",
      "app.elizacloud.ai",
      "dev.elizacloud.ai",
      "api.elizacloud.ai",
    ]) {
      expect(resolveCloudApiBase(`https://${host}`)).toBe(
        "https://api.eliza.app",
      );
    }
  });

  it("keeps staging hosts on staging instead of redirecting to production", () => {
    for (const host of [
      "staging.eliza.app",
      "cloud-staging.eliza.app",
      "api-staging.eliza.app",
      "staging.elizacloud.ai",
      "app-staging.elizacloud.ai",
      "api-staging.elizacloud.ai",
    ]) {
      expect(resolveCloudApiBase(`https://${host}`)).toBe(
        "https://api-staging.eliza.app",
      );
    }
  });

  it("never crosses the staging/production boundary in either direction", () => {
    expect(resolveCloudApiBase("https://api-staging.eliza.app")).not.toBe(
      "https://api.eliza.app",
    );
    expect(resolveCloudApiBase("https://eliza.app")).not.toBe(
      "https://api-staging.eliza.app",
    );
  });

  it("strips a trailing /api/v1 — SIWE endpoints live at the origin", () => {
    expect(resolveCloudApiBase("https://api-staging.eliza.app/api/v1")).toBe(
      "https://api-staging.eliza.app",
    );
    expect(resolveCloudApiBase("https://elizacloud.ai/api/v1/")).toBe(
      "https://api.eliza.app",
    );
  });

  it("leaves a self-hosted or loopback base exactly as given", () => {
    expect(resolveCloudApiBase("https://cloud.example.com")).toBe(
      "https://cloud.example.com",
    );
    // Port and scheme must survive — a local cloud stack runs on http+port.
    expect(resolveCloudApiBase("http://127.0.0.1:8787")).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("falls back to ELIZAOS_CLOUD_BASE_URL, then production, when no input is given", () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app";
    expect(resolveCloudApiBase()).toBe("https://api-staging.eliza.app");

    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    expect(resolveCloudApiBase()).toBe("https://api.eliza.app");
  });

  it("an explicit argument outranks the environment variable", () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://eliza.app";
    expect(resolveCloudApiBase("https://api-staging.eliza.app")).toBe(
      "https://api-staging.eliza.app",
    );
  });

  it("returns an unparseable base trimmed rather than throwing", () => {
    expect(resolveCloudApiBase("not a url///")).toBe("not a url");
  });
});
