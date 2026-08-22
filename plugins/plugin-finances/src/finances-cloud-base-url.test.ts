/**
 * Pins the finances Plaid config against the SDK's base-URL contract.
 *
 * `PlaidManagedClient` hands `config.apiBaseUrl` straight to `ElizaCloudClient`,
 * which accepts an origin or a base ending at `/api/v1` and throws on anything
 * else. The route-level webhook tests stub below that constructor, so they stay
 * green on a base the real client would reject — this asserts against the real
 * constructor instead.
 */
import { ElizaCloudClient } from "@elizaos/cloud-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFinancesCloudManagedClientConfig } from "./finances-service";

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => ({}),
}));

describe("finances cloud managed-client base URL", () => {
  const previous = process.env.ELIZAOS_CLOUD_BASE_URL;

  beforeEach(() => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://cloud.example";
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.ELIZAOS_CLOUD_BASE_URL;
    else process.env.ELIZAOS_CLOUD_BASE_URL = previous;
  });

  it("produces a base the real SDK client accepts", () => {
    const config = resolveFinancesCloudManagedClientConfig();
    const client = new ElizaCloudClient({
      baseUrl: config.siteUrl,
      apiBaseUrl: config.apiBaseUrl,
      apiKey: "test-key",
    });
    expect(client.apiBaseUrl).toBe("https://cloud.example/api/v1");
  });

  it("rejects a base trimmed to /api, so the trim cannot be reintroduced", () => {
    const config = resolveFinancesCloudManagedClientConfig();
    expect(() => {
      new ElizaCloudClient({
        baseUrl: config.siteUrl,
        apiBaseUrl: config.apiBaseUrl.replace(/\/v1$/, ""),
        apiKey: "test-key",
      });
    }).toThrow(/must be an origin or end at \/api\/v1/);
  });
});
