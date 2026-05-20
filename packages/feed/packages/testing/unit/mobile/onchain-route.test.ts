import { describe, expect, it } from "bun:test";

/**
 * Tests for the /api/onchain route's input validation and token extraction.
 *
 * The actual on-chain transaction logic depends on @feed/api and
 * Privy server auth, which require live infrastructure. These tests
 * verify the request parsing and validation layer.
 */

// Simulate the extractPrivyToken logic from the route
function extractPrivyToken(request: {
  cookies: Map<string, string>;
  headers: Map<string, string>;
}): string {
  const cookieToken = request.cookies.get("privy-token");
  const authHeader = request.headers.get("authorization");
  const headerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : undefined;

  const token = headerToken ?? cookieToken;
  if (!token) {
    throw new Error("Authentication required: no Privy token found.");
  }
  return token;
}

// Simulate the validation logic from the route handler
function validateOnchainRequest(body: Record<string, unknown>): {
  valid: boolean;
  error?: string;
} {
  const action = body.action as string;
  if (!action) {
    return { valid: false, error: "Missing required field: action" };
  }

  switch (action) {
    case "buy-shares":
    case "sell-shares":
      if (!body.marketId || !body.outcome || body.numShares == null) {
        return {
          valid: false,
          error: "Missing required fields: marketId, outcome, numShares",
        };
      }
      return { valid: true };

    case "update-agent-profile":
      if (!body.metadata) {
        return { valid: false, error: "Missing required field: metadata" };
      }
      return { valid: true };

    default:
      return { valid: false, error: `Unknown action: ${action}` };
  }
}

describe("/api/onchain — token extraction", () => {
  it("prefers Bearer token over cookie", () => {
    const token = extractPrivyToken({
      cookies: new Map([["privy-token", "cookie-token"]]),
      headers: new Map([["authorization", "Bearer header-token"]]),
    });
    expect(token).toBe("header-token");
  });

  it("falls back to cookie when no Authorization header", () => {
    const token = extractPrivyToken({
      cookies: new Map([["privy-token", "cookie-token"]]),
      headers: new Map(),
    });
    expect(token).toBe("cookie-token");
  });

  it("throws when no token is available", () => {
    expect(() =>
      extractPrivyToken({
        cookies: new Map(),
        headers: new Map(),
      }),
    ).toThrow("Authentication required");
  });

  it("ignores non-Bearer auth headers", () => {
    expect(() =>
      extractPrivyToken({
        cookies: new Map(),
        headers: new Map([["authorization", "Basic dXNlcjpwYXNz"]]),
      }),
    ).toThrow("Authentication required");
  });

  it("handles empty Bearer token", () => {
    // "Bearer " with nothing after it — substring(7) returns ""
    expect(() =>
      extractPrivyToken({
        cookies: new Map(),
        headers: new Map([["authorization", "Bearer "]]),
      }),
    ).toThrow("Authentication required");
  });
});

describe("/api/onchain — request validation", () => {
  describe("buy-shares action", () => {
    it("valid with all required fields", () => {
      const result = validateOnchainRequest({
        action: "buy-shares",
        marketId: "market-123",
        outcome: "YES",
        numShares: 10,
      });
      expect(result.valid).toBe(true);
    });

    it("invalid without marketId", () => {
      const result = validateOnchainRequest({
        action: "buy-shares",
        outcome: "YES",
        numShares: 10,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("marketId");
    });

    it("invalid without outcome", () => {
      const result = validateOnchainRequest({
        action: "buy-shares",
        marketId: "market-123",
        numShares: 10,
      });
      expect(result.valid).toBe(false);
    });

    it("invalid without numShares", () => {
      const result = validateOnchainRequest({
        action: "buy-shares",
        marketId: "market-123",
        outcome: "YES",
      });
      expect(result.valid).toBe(false);
    });

    it("valid with numShares = 0", () => {
      const result = validateOnchainRequest({
        action: "buy-shares",
        marketId: "market-123",
        outcome: "YES",
        numShares: 0,
      });
      // numShares == null check: 0 == null is false, so this is valid
      expect(result.valid).toBe(true);
    });
  });

  describe("sell-shares action", () => {
    it("valid with all required fields", () => {
      const result = validateOnchainRequest({
        action: "sell-shares",
        marketId: "market-456",
        outcome: "NO",
        numShares: 5.5,
      });
      expect(result.valid).toBe(true);
    });

    it("invalid without marketId", () => {
      const result = validateOnchainRequest({
        action: "sell-shares",
        outcome: "NO",
        numShares: 5,
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("update-agent-profile action", () => {
    it("valid with metadata", () => {
      const result = validateOnchainRequest({
        action: "update-agent-profile",
        metadata: { name: "Agent Smith" },
      });
      expect(result.valid).toBe(true);
    });

    it("invalid without metadata", () => {
      const result = validateOnchainRequest({
        action: "update-agent-profile",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("metadata");
    });
  });

  describe("unknown action", () => {
    it("rejects unknown action", () => {
      const result = validateOnchainRequest({
        action: "transfer-tokens",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("transfer-tokens");
    });
  });

  describe("missing action", () => {
    it("rejects missing action field", () => {
      const result = validateOnchainRequest({
        marketId: "market-123",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("action");
    });

    it("rejects empty body", () => {
      const result = validateOnchainRequest({});
      expect(result.valid).toBe(false);
    });
  });
});

describe("/api/onchain — marketId conversion", () => {
  // Replicate the marketIdToBytes32 logic
  function marketIdToBytes32(marketId: string): string {
    const bigintValue = BigInt(marketId);
    const hex = bigintValue.toString(16).padStart(64, "0");
    return `0x${hex}`;
  }

  it("converts numeric string market ID to bytes32", () => {
    const result = marketIdToBytes32("1");
    expect(result).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("converts large market ID", () => {
    const result = marketIdToBytes32("255");
    expect(result).toBe(
      "0x00000000000000000000000000000000000000000000000000000000000000ff",
    );
  });

  it("converts zero market ID", () => {
    const result = marketIdToBytes32("0");
    expect(result).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("converts very large market ID", () => {
    const result = marketIdToBytes32("999999999999999999");
    expect(result.length).toBe(66); // 0x + 64 hex chars
    expect(result.startsWith("0x")).toBe(true);
  });

  it("throws on non-numeric market ID", () => {
    expect(() => marketIdToBytes32("not-a-number")).toThrow();
  });
});
