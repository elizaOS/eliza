import { describe, expect, it } from "vitest";

import { isCloudApiKeyToken } from "./cloud-api-key-token";

describe("isCloudApiKeyToken (#12046)", () => {
  it("accepts an `eliza_`-prefixed cloud API key", () => {
    expect(isCloudApiKeyToken("eliza_live_abc123")).toBe(true);
    expect(isCloudApiKeyToken("eliza_test_org_a_key")).toBe(true);
    // leading/trailing whitespace is tolerated (tokens are trimmed at source)
    expect(isCloudApiKeyToken("  eliza_live_abc123  ")).toBe(true);
  });

  it("rejects the on-device agent bearer (the #12046 wrong-auth cause)", () => {
    // A JWT-shaped local agent bearer — mirrored into bootConfig.apiToken by
    // first-run-finish — must NOT read as a cloud session.
    expect(
      isCloudApiKeyToken(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZ2VudCJ9.sig",
      ),
    ).toBe(false);
    // an opaque non-prefixed bearer
    expect(isCloudApiKeyToken("agent-bearer-1234567890")).toBe(false);
  });

  it("rejects empty / nullish / non-string input", () => {
    expect(isCloudApiKeyToken("")).toBe(false);
    expect(isCloudApiKeyToken("   ")).toBe(false);
    expect(isCloudApiKeyToken(null)).toBe(false);
    expect(isCloudApiKeyToken(undefined)).toBe(false);
  });

  it("does not match a token that merely contains `eliza_` later on", () => {
    expect(isCloudApiKeyToken("not_eliza_key")).toBe(false);
    expect(isCloudApiKeyToken("Bearer eliza_live_abc")).toBe(false);
  });
});
