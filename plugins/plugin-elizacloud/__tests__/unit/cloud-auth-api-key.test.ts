import { describe, expect, it } from "vitest";
import { CloudAuthService } from "../../services/cloud-auth";

describe("CloudAuthService API key authentication", () => {
  it("hydrates credentials from a persisted API key without a network round trip", () => {
    const auth = new CloudAuthService();

    const credentials = auth.authenticateWithApiKey({
      apiKey: " eliza_test_key ",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(credentials.apiKey).toBe("eliza_test_key");
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.getApiKey()).toBe("eliza_test_key");
    expect(auth.getOrganizationId()).toBe("org-1");
    expect(auth.getUserId()).toBe("user-1");
  });

  it("clears both credentials and the backing client API key", () => {
    const auth = new CloudAuthService();
    auth.authenticateWithApiKey({ apiKey: "eliza_test_key" });

    auth.clearAuth();

    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.getCredentials()).toBeNull();
    expect(auth.getApiKey()).toBeUndefined();
  });

  it("rejects empty API keys", () => {
    const auth = new CloudAuthService();

    expect(() => auth.authenticateWithApiKey({ apiKey: "   " })).toThrow(
      "Eliza Cloud API key is required"
    );
  });
});
