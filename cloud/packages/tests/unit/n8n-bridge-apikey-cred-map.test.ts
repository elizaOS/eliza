/**
 * N8N Bridge — API Key Credential Type Mapping Unit Tests
 *
 * Tests for lib/eliza/plugin-n8n-bridge/apikey-cred-map.ts
 * Verifies API key credential type → data builder mapping.
 */

import { describe, expect, test } from "bun:test";
import { API_KEY_CRED_TYPES } from "@/lib/eliza/plugin-n8n-bridge/apikey-cred-map";

describe("API_KEY_CRED_TYPES", () => {
  test("openAiApi builds correct data payload", () => {
    const mapping = API_KEY_CRED_TYPES["openAiApi"];
    expect(mapping).toBeDefined();

    const data = mapping.buildData("eliza_test123", "https://cloud.elizaos.com");
    expect(data).toEqual({
      apiKey: "eliza_test123",
      organizationId: "",
      url: "https://cloud.elizaos.com/api/v1",
      header: false,
    });
  });

  test("openAiApi appends /api/v1 to base URL", () => {
    const data = API_KEY_CRED_TYPES["openAiApi"].buildData("key", "https://example.com");
    expect(data.url).toBe("https://example.com/api/v1");
  });

  test("unknown credential type is not in the map", () => {
    expect(API_KEY_CRED_TYPES["gmailOAuth2Api"]).toBeUndefined();
    expect(API_KEY_CRED_TYPES["stripeApi"]).toBeUndefined();
  });
});
