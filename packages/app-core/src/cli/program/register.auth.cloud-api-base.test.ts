/**
 * Tests for `resolveCloudApiBase()` — the web-host → API-host mapping the cloud
 * auth commands use to decide WHICH Eliza Cloud deployment they authenticate
 * against.
 *
 * The environment boundary is the whole point: a blanket "any *.elizacloud.ai →
 * api.elizacloud.ai" rewrite sent staging hosts to PRODUCTION, so
 * `dev-login --cloud https://api-staging.elizacloud.ai` minted a prod key and
 * reported success — a staging credential was unobtainable and you could not
 * tell. These cases pin each environment to itself so that cannot regress
 * silently.
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
      "elizacloud.ai",
      "www.elizacloud.ai",
      "app.elizacloud.ai",
      "dev.elizacloud.ai",
      "api.elizacloud.ai",
    ]) {
      expect(resolveCloudApiBase(`https://${host}`)).toBe(
        "https://api.elizacloud.ai",
      );
    }
  });

  it("keeps staging hosts on staging instead of redirecting to production", () => {
    for (const host of [
      "staging.elizacloud.ai",
      "app-staging.elizacloud.ai",
      "api-staging.elizacloud.ai",
    ]) {
      expect(resolveCloudApiBase(`https://${host}`)).toBe(
        "https://api-staging.elizacloud.ai",
      );
    }
  });

  it("never crosses the staging/production boundary in either direction", () => {
    expect(resolveCloudApiBase("https://api-staging.elizacloud.ai")).not.toBe(
      "https://api.elizacloud.ai",
    );
    expect(resolveCloudApiBase("https://elizacloud.ai")).not.toBe(
      "https://api-staging.elizacloud.ai",
    );
  });

  it("strips a trailing /api/v1 — SIWE endpoints live at the origin", () => {
    expect(
      resolveCloudApiBase("https://api-staging.elizacloud.ai/api/v1"),
    ).toBe("https://api-staging.elizacloud.ai");
    expect(resolveCloudApiBase("https://elizacloud.ai/api/v1/")).toBe(
      "https://api.elizacloud.ai",
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
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.elizacloud.ai";
    expect(resolveCloudApiBase()).toBe("https://api-staging.elizacloud.ai");

    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    expect(resolveCloudApiBase()).toBe("https://api.elizacloud.ai");
  });

  it("an explicit argument outranks the environment variable", () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://elizacloud.ai";
    expect(resolveCloudApiBase("https://api-staging.elizacloud.ai")).toBe(
      "https://api-staging.elizacloud.ai",
    );
  });

  it("returns an unparseable base trimmed rather than throwing", () => {
    expect(resolveCloudApiBase("not a url///")).toBe("not a url");
  });
});
