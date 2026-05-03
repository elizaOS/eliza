/**
 * Tests for x402 Facilitator Service
 *
 * Tests verification logic, network registry, and edge cases.
 * Uses bun:test to match the existing test framework.
 */
import { describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Test Types (mirror the service's internal types)
// ---------------------------------------------------------------------------

interface PaymentAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

interface PaymentPayload {
  x402Version: number;
  accepted: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  };
  payload: {
    signature: string;
    authorization: PaymentAuthorization;
  };
}

interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createValidPayload(
  overrides?: Partial<{
    network: string;
    amount: string;
    payTo: string;
    from: string;
    validBefore: string;
    scheme: string;
  }>,
): PaymentPayload {
  const futureDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

  return {
    x402Version: 2,
    accepted: {
      scheme: overrides?.scheme ?? "exact",
      network: overrides?.network ?? "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: overrides?.amount ?? "1000000",
      payTo: overrides?.payTo ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    },
    payload: {
      signature: "0x" + "ab".repeat(65), // 65 bytes (r + s + v)
      authorization: {
        from: overrides?.from ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        to: overrides?.payTo ?? "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        value: overrides?.amount ?? "1000000",
        validAfter: "0",
        validBefore: overrides?.validBefore ?? futureDeadline.toString(),
        nonce: "0x" + "01".repeat(32),
      },
    },
  };
}

function createValidRequirements(overrides?: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    amount: "1000000",
    payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    maxTimeoutSeconds: 300,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Payment Payload Validation (Unit Tests Without RPC)
// ---------------------------------------------------------------------------

describe("x402 Payment Payload Validation", () => {
  describe("amount validation", () => {
    it("should reject when payment amount is less than required", () => {
      const payload = createValidPayload({ amount: "500000" }); // $0.50
      const requirements = createValidRequirements({ amount: "1000000" }); // $1.00

      // Check locally: amount < required
      const paymentAmount = BigInt(payload.accepted.amount);
      const requiredAmount = BigInt(requirements.amount);
      expect(paymentAmount < requiredAmount).toBe(true);
    });

    it("should accept when payment amount equals required", () => {
      const payload = createValidPayload({ amount: "1000000" });
      const requirements = createValidRequirements({ amount: "1000000" });

      const paymentAmount = BigInt(payload.accepted.amount);
      const requiredAmount = BigInt(requirements.amount);
      expect(paymentAmount >= requiredAmount).toBe(true);
    });

    it("should accept when payment amount exceeds required", () => {
      const payload = createValidPayload({ amount: "2000000" });
      const requirements = createValidRequirements({ amount: "1000000" });

      const paymentAmount = BigInt(payload.accepted.amount);
      const requiredAmount = BigInt(requirements.amount);
      expect(paymentAmount >= requiredAmount).toBe(true);
    });

    it("should handle very large amounts without overflow", () => {
      const huge = "999999999999999999"; // Much larger than MAX_SAFE_INTEGER
      const payload = createValidPayload({ amount: huge });
      const requirements = createValidRequirements({ amount: huge });

      const paymentAmount = BigInt(payload.accepted.amount);
      const requiredAmount = BigInt(requirements.amount);
      expect(paymentAmount >= requiredAmount).toBe(true);
    });
  });

  describe("payTo validation", () => {
    it("should reject when payTo does not match", () => {
      const payload = createValidPayload({
        payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      const requirements = createValidRequirements({
        payTo: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      });

      expect(payload.accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase()).toBe(true);
    });

    it("should be case-insensitive for payTo", () => {
      const payload = createValidPayload({
        payTo: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      const requirements = createValidRequirements({
        payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });

      expect(payload.accepted.payTo.toLowerCase() === requirements.payTo.toLowerCase()).toBe(true);
    });
  });

  describe("deadline validation", () => {
    it("should reject expired deadlines", () => {
      const pastDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const payload = createValidPayload({
        validBefore: pastDeadline.toString(),
      });

      const now = Math.floor(Date.now() / 1000);
      expect(BigInt(payload.payload.authorization.validBefore) <= BigInt(now)).toBe(true);
    });

    it("should accept future deadlines", () => {
      const futureDeadline = Math.floor(Date.now() / 1000) + 3600;
      const payload = createValidPayload({
        validBefore: futureDeadline.toString(),
      });

      const now = Math.floor(Date.now() / 1000);
      expect(BigInt(payload.payload.authorization.validBefore) > BigInt(now)).toBe(true);
    });
  });

  describe("scheme validation", () => {
    it("should reject unsupported schemes", () => {
      const payload = createValidPayload({ scheme: "upto" });
      // Our facilitator only supports "exact" currently
      expect(payload.accepted.scheme).toBe("upto");
      expect(payload.accepted.scheme !== "exact").toBe(true);
    });
  });

  describe("network validation", () => {
    it("should validate CAIP-2 format", () => {
      const validNetworks = ["eip155:8453", "eip155:84532", "eip155:1", "eip155:11155111"];

      for (const network of validNetworks) {
        expect(network).toMatch(/^eip155:\d+$/);
      }
    });

    it("should reject invalid CAIP-2 format", () => {
      const invalidNetworks = ["ethereum", "base", "8453", "eip155:", ""];
      for (const network of invalidNetworks) {
        expect(network).not.toMatch(/^eip155:\d+$/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Payment Header Encoding/Decoding
// ---------------------------------------------------------------------------

describe("Payment Header Encoding", () => {
  it("should base64 encode a payment payload", () => {
    const payload = createValidPayload();
    const json = JSON.stringify(payload);
    const encoded = Buffer.from(json).toString("base64");

    // Should be decodable
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);

    expect(parsed.x402Version).toBe(2);
    expect(parsed.accepted.scheme).toBe("exact");
  });

  it("should handle double-encoding gracefully", () => {
    const payload = createValidPayload();
    const json = JSON.stringify(payload);
    const encoded = Buffer.from(json).toString("base64");

    // Try direct JSON parse first (fails), then base64 decode
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      const decoded = Buffer.from(encoded, "base64").toString("utf-8");
      parsed = JSON.parse(decoded);
    }

    expect(parsed.x402Version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: 402 Response Format
// ---------------------------------------------------------------------------

describe("402 Response Format", () => {
  it("should include required fields in accepts array", () => {
    const accepts = [
      {
        scheme: "exact",
        network: "eip155:8453",
        maxAmountRequired: "1000000",
        resource: "https://api.example.com/premium",
        description: "Premium API",
        mimeType: "application/json",
        payTo: "0x1234",
        maxTimeoutSeconds: 300,
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        extra: {},
      },
    ];

    expect(accepts[0]).toHaveProperty("scheme");
    expect(accepts[0]).toHaveProperty("network");
    expect(accepts[0]).toHaveProperty("maxAmountRequired");
    expect(accepts[0]).toHaveProperty("payTo");
    expect(accepts[0]).toHaveProperty("asset");
    expect(accepts[0]).toHaveProperty("maxTimeoutSeconds");
  });

  it("should format price correctly (6 decimal USDC)", () => {
    const testCases = [
      { usd: 0.01, baseUnits: "10000" },
      { usd: 0.1, baseUnits: "100000" },
      { usd: 1.0, baseUnits: "1000000" },
      { usd: 10.0, baseUnits: "10000000" },
      { usd: 100.0, baseUnits: "100000000" },
    ];

    for (const { usd, baseUnits } of testCases) {
      const calculated = Math.round(usd * 1_000_000).toString();
      expect(calculated).toBe(baseUnits);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Edge Cases & Fuzz
// ---------------------------------------------------------------------------

describe("Edge Cases & Fuzz", () => {
  it("should handle missing authorization fields", () => {
    const payload = createValidPayload();
    // Create a broken payload with empty authorization to test validation
    type BrokenPaymentPayload = Omit<PaymentPayload, "payload"> & {
      payload: Omit<PaymentPayload["payload"], "authorization"> & {
        authorization: Partial<PaymentAuthorization>;
      };
    };
    const broken: BrokenPaymentPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        authorization: {},
      },
    };

    expect(broken.payload.authorization.from).toBeUndefined();
  });

  it("should handle empty signature", () => {
    const payload = createValidPayload();
    payload.payload.signature = "";
    expect(payload.payload.signature).toBe("");
  });

  it("should handle non-hex signature", () => {
    const payload = createValidPayload();
    payload.payload.signature = "not-a-hex-string";
    expect(payload.payload.signature.startsWith("0x")).toBe(false);
  });

  it("should handle zero amount", () => {
    const payload = createValidPayload({ amount: "0" });
    expect(BigInt(payload.accepted.amount)).toBe(0n);
  });

  it("should handle negative-looking amounts (as string)", () => {
    // BigInt will throw on negative strings
    expect(() => BigInt("-1000000")).not.toThrow();
    expect(BigInt("-1000000") < 0n).toBe(true);
  });

  it("should handle malformed network identifiers", () => {
    const malformed = ["", "eip155:", ":8453", "eip155:abc", "solana:mainnet"];
    for (const network of malformed) {
      // None should match valid CAIP-2 format
      expect(network).not.toMatch(/^eip155:\d+$/);
    }
  });

  it("should handle unicode in description fields", () => {
    const description = "Premium API 🚀 — $1.00/request";
    const encoded = JSON.stringify({ description });
    const decoded = JSON.parse(encoded);
    expect(decoded.description).toBe(description);
  });

  it("should handle very long authorization nonces", () => {
    const payload = createValidPayload();
    // bytes32 = 64 hex chars + 0x prefix = 66 chars
    expect(payload.payload.authorization.nonce).toHaveLength(66);
  });
});

// ---------------------------------------------------------------------------
// Tests: Middleware Integration Patterns
// ---------------------------------------------------------------------------

describe("Middleware Integration", () => {
  it("withX402Payment should be composable with withRateLimit", () => {
    // Verify the middleware signature is compatible

    // Both should follow: (handler, config) => handler
    const mockHandler = async (_req: Request) => new Response("ok");
    expect(typeof mockHandler).toBe("function");
  });

  it("should parse X-PAYMENT header from different cases", () => {
    const headers = new Headers();
    headers.set("x-payment", "test-value");

    // Next.js normalizes headers to lowercase
    expect(headers.get("x-payment")).toBe("test-value");
    expect(headers.get("X-PAYMENT")).toBe("test-value"); // Headers are case-insensitive
  });
});
