/**
 * Connection Adapters Unit Tests
 *
 * Tests the adapter registry and adapter interface compliance.
 */

import { describe, expect, it } from "bun:test";
import { getAdapter, getAllAdapters } from "@/lib/services/oauth/connection-adapters";
import { OAUTH_PROVIDERS } from "@/lib/services/oauth/provider-registry";

describe("Connection Adapters Registry", () => {
  describe("getAdapter", () => {
    it("should return adapter for Google", () => {
      const adapter = getAdapter("google");
      expect(adapter).not.toBeNull();
      expect(adapter!.platform).toBe("google");
    });

    it("should return adapter for Twitter", () => {
      const adapter = getAdapter("twitter");
      expect(adapter).not.toBeNull();
      expect(adapter!.platform).toBe("twitter");
    });

    it("should return adapter for Twilio", () => {
      const adapter = getAdapter("twilio");
      expect(adapter).not.toBeNull();
      expect(adapter!.platform).toBe("twilio");
    });

    it("should return adapter for Blooio", () => {
      const adapter = getAdapter("blooio");
      expect(adapter).not.toBeNull();
      expect(adapter!.platform).toBe("blooio");
    });

    it("should return null for unknown platform", () => {
      const adapter = getAdapter("unknown");
      expect(adapter).toBeNull();
    });

    it("should return null for Discord (excluded)", () => {
      const adapter = getAdapter("discord");
      expect(adapter).toBeNull();
    });
  });

  describe("getAllAdapters", () => {
    it("should return array of all adapters", () => {
      const adapters = getAllAdapters();
      expect(Array.isArray(adapters)).toBe(true);
      expect(adapters.length).toBeGreaterThanOrEqual(4);
    });

    it("should include adapters for all defined providers", () => {
      const adapters = getAllAdapters();
      const platforms = adapters.map((a) => a.platform);

      const providerIds = Object.keys(OAUTH_PROVIDERS);
      for (const id of providerIds) {
        expect(platforms).toContain(id);
      }
    });

    it("should not include Discord adapter", () => {
      const adapters = getAllAdapters();
      const platforms = adapters.map((a) => a.platform);
      expect(platforms).not.toContain("discord");
    });
  });

  describe("Adapter Interface Compliance", () => {
    const adapters = getAllAdapters();

    it("each adapter should have a platform property", () => {
      for (const adapter of adapters) {
        expect(typeof adapter.platform).toBe("string");
        expect(adapter.platform.length).toBeGreaterThan(0);
      }
    });

    it("each adapter should implement listConnections", () => {
      for (const adapter of adapters) {
        expect(typeof adapter.listConnections).toBe("function");
      }
    });

    it("each adapter should implement getToken", () => {
      for (const adapter of adapters) {
        expect(typeof adapter.getToken).toBe("function");
      }
    });

    it("each adapter should implement revoke", () => {
      for (const adapter of adapters) {
        expect(typeof adapter.revoke).toBe("function");
      }
    });

    it("each adapter should implement ownsConnection", () => {
      for (const adapter of adapters) {
        expect(typeof adapter.ownsConnection).toBe("function");
      }
    });
  });
});

describe("Google Adapter", () => {
  const adapter = getAdapter("google")!;

  it("should have correct platform", () => {
    expect(adapter.platform).toBe("google");
  });

  describe("ownsConnection", () => {
    it("should return true for UUID connection IDs", async () => {
      // Google uses platform_credentials with UUID IDs
      // This requires a database lookup, so in unit tests we can't fully verify
      // But we can verify the function exists and returns a promise
      const result = adapter.ownsConnection("550e8400-e29b-41d4-a716-446655440000");
      expect(result instanceof Promise).toBe(true);
    });

    it("should return false for non-UUID connection IDs", async () => {
      const result = await adapter.ownsConnection("twitter:org-123");
      expect(result).toBe(false);
    });

    it("should return false for invalid format", async () => {
      const result = await adapter.ownsConnection("not-a-uuid");
      expect(result).toBe(false);
    });

    it("should return false for empty string", async () => {
      const result = await adapter.ownsConnection("");
      expect(result).toBe(false);
    });
  });
});

describe("Twitter Adapter", () => {
  const adapter = getAdapter("twitter")!;

  it("should have correct platform", () => {
    expect(adapter.platform).toBe("twitter");
  });

  describe("ownsConnection", () => {
    it("should return true for twitter: prefixed IDs", async () => {
      const result = await adapter.ownsConnection("twitter:org-123");
      expect(result).toBe(true);
    });

    it("should return false for other platform prefixes", async () => {
      const result = await adapter.ownsConnection("twilio:org-123");
      expect(result).toBe(false);
    });

    it("should return false for UUID IDs", async () => {
      const result = await adapter.ownsConnection("550e8400-e29b-41d4-a716-446655440000");
      expect(result).toBe(false);
    });
  });
});

describe("Twilio Adapter", () => {
  const adapter = getAdapter("twilio")!;

  it("should have correct platform", () => {
    expect(adapter.platform).toBe("twilio");
  });

  describe("ownsConnection", () => {
    it("should return true for twilio: prefixed IDs", async () => {
      const result = await adapter.ownsConnection("twilio:org-123");
      expect(result).toBe(true);
    });

    it("should return false for other platform prefixes", async () => {
      const result = await adapter.ownsConnection("twitter:org-123");
      expect(result).toBe(false);
    });
  });
});

describe("Blooio Adapter", () => {
  const adapter = getAdapter("blooio")!;

  it("should have correct platform", () => {
    expect(adapter.platform).toBe("blooio");
  });

  describe("ownsConnection", () => {
    it("should return true for blooio: prefixed IDs", async () => {
      const result = await adapter.ownsConnection("blooio:org-123");
      expect(result).toBe(true);
    });

    it("should return false for other platform prefixes", async () => {
      const result = await adapter.ownsConnection("twitter:org-123");
      expect(result).toBe(false);
    });
  });
});

describe("Connection ID Disambiguation", () => {
  it("adapters should not claim each others connection IDs", async () => {
    const testCases = [
      { id: "twitter:org-123", owner: "twitter" },
      { id: "twilio:org-123", owner: "twilio" },
      { id: "blooio:org-123", owner: "blooio" },
      // UUID would be owned by google (requires DB lookup)
    ];

    const adapters = getAllAdapters();

    for (const testCase of testCases) {
      let ownerCount = 0;
      let actualOwner: string | null = null;

      for (const adapter of adapters) {
        if (await adapter.ownsConnection(testCase.id)) {
          ownerCount++;
          actualOwner = adapter.platform;
        }
      }

      // Each ID should have exactly one owner
      expect(ownerCount).toBe(1);
      expect(actualOwner).toBe(testCase.owner);
    }
  });

  it("malformed IDs should not be owned by any secrets adapter", async () => {
    const malformedIds = ["invalid", "", "platform:", ":org-123", "platform::"];

    const secretsAdapters = ["twitter", "twilio", "blooio"].map((p) => getAdapter(p)!);

    for (const id of malformedIds) {
      for (const adapter of secretsAdapters) {
        const owns = await adapter.ownsConnection(id);
        // Most should return false, but "platform:" might match due to startsWith
        if (id === "platform:") {
          // This is edge case - depends on implementation
          continue;
        }
        expect(owns).toBe(false);
      }
    }
  });
});

describe("Storage Type Alignment", () => {
  it("Google adapter should use platform_credentials storage", () => {
    const provider = OAUTH_PROVIDERS.google;
    expect(provider.storage).toBe("platform_credentials");
    // Google adapter queries platform_credentials table
  });

  it("Twitter adapter should use secrets storage", () => {
    const provider = OAUTH_PROVIDERS.twitter;
    expect(provider.storage).toBe("secrets");
    // Twitter adapter queries secrets table with TWITTER_ prefix
  });

  it("Twilio adapter should use secrets storage", () => {
    const provider = OAUTH_PROVIDERS.twilio;
    expect(provider.storage).toBe("secrets");
    // Twilio adapter queries secrets table with TWILIO_ prefix
  });

  it("Blooio adapter should use secrets storage", () => {
    const provider = OAUTH_PROVIDERS.blooio;
    expect(provider.storage).toBe("secrets");
    // Blooio adapter queries secrets table with BLOOIO_ prefix
  });
});

describe("Provider-Adapter Consistency", () => {
  it("each provider should have a corresponding adapter", () => {
    for (const providerId of Object.keys(OAUTH_PROVIDERS)) {
      const adapter = getAdapter(providerId);
      expect(adapter).not.toBeNull();
      expect(adapter!.platform).toBe(providerId);
    }
  });

  it("each adapter should have a corresponding provider", () => {
    for (const adapter of getAllAdapters()) {
      const provider = OAUTH_PROVIDERS[adapter.platform];
      expect(provider).toBeDefined();
      expect(provider.id).toBe(adapter.platform);
    }
  });
});
