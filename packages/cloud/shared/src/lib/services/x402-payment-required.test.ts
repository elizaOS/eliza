/**
 * Tests for the x402 v2 payment-required envelope builder; deterministic unit tests with no I/O or mocks.
 * Verifies top-level v2 envelope construction, legacy resource projection, and complete preservation
 * of payment-bearing requirements and typed permit context extensions across the envelope boundary.
 */

import { describe, expect, it } from "vitest";
import { buildX402PaymentRequired } from "./x402-payment-required";

interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    paymentRequestId: string;
    amountUsd: number;
    platformFeeUsd: number;
    platformFeeBps: number;
    serviceFeeUsd: number;
    totalChargedUsd: number;
    fee?: {
      caller: string;
      feeTo: string;
      feeAmount: string;
    };
    feePayer?: string;
    memo?: string;
  };
}

interface PaymentRequiredExtensions {
  paymentPermitContext?: {
    meta: {
      kind: "PAYMENT_ONLY";
      paymentId: string;
      nonce: string;
      validAfter: number;
      validBefore: number;
    };
  };
}

describe("buildX402PaymentRequired", () => {
  const representativeRequirements: PaymentRequirements = {
    scheme: "exact_permit",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "50000",
    maxAmountRequired: "50000",
    resource: "https://pay.example.com/api/v1/x402/requests/req-123/settle",
    description: "API access fee",
    mimeType: "application/json",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 300,
    extra: {
      paymentRequestId: "req-123",
      amountUsd: 0.05,
      platformFeeUsd: 0.0005,
      platformFeeBps: 100,
      serviceFeeUsd: 0.01,
      totalChargedUsd: 0.0605,
      fee: {
        caller: "0x2222222222222222222222222222222222222222",
        feeTo: "0x0000000000000000000000000000000000000000",
        feeAmount: "0",
      },
    },
  };

  const representativeExtensions: PaymentRequiredExtensions = {
    paymentPermitContext: {
      meta: {
        kind: "PAYMENT_ONLY",
        paymentId: "req-123",
        nonce: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        validAfter: 1700000000,
        validBefore: 1700000900,
      },
    },
  };

  it("builds v2 envelope with legacy resource projection and complete payment-bearing accepts requirements", () => {
    const res = buildX402PaymentRequired(representativeRequirements);

    expect(res.x402Version).toBe(2);
    expect(res.error).toBe("payment_required");
    expect(res.resource).toEqual({
      url: representativeRequirements.resource,
      description: representativeRequirements.description,
      mimeType: representativeRequirements.mimeType,
    });
    expect(res.accepts).toEqual([representativeRequirements]);

    // Prove all security and payment-bearing fields survive unchanged
    const entry = res.accepts[0];
    expect(entry.scheme).toBe("exact_permit");
    expect(entry.network).toBe("eip155:8453");
    expect(entry.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(entry.amount).toBe("50000");
    expect(entry.maxAmountRequired).toBe("50000");
    expect(entry.resource).toBe("https://pay.example.com/api/v1/x402/requests/req-123/settle");
    expect(entry.description).toBe("API access fee");
    expect(entry.mimeType).toBe("application/json");
    expect(entry.payTo).toBe("0x1111111111111111111111111111111111111111");
    expect(entry.maxTimeoutSeconds).toBe(300);
    expect(entry.extra).toEqual(representativeRequirements.extra);
    expect(entry.extra.paymentRequestId).toBe("req-123");
    expect(entry.extra.totalChargedUsd).toBe(0.0605);
    expect(entry.extra.fee).toEqual({
      caller: "0x2222222222222222222222222222222222222222",
      feeTo: "0x0000000000000000000000000000000000000000",
      feeAmount: "0",
    });
  });

  it("includes typed paymentPermitContext extensions when provided and proves fields survive unchanged", () => {
    const res = buildX402PaymentRequired(representativeRequirements, representativeExtensions);

    expect(res).toHaveProperty("extensions");
    expect(res.extensions).toEqual(representativeExtensions);

    // Prove paymentPermitContext shape and permit bounds survive unchanged without type assertion bypass
    expect(res.extensions?.paymentPermitContext?.meta).toEqual({
      kind: "PAYMENT_ONLY",
      paymentId: "req-123",
      nonce: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      validAfter: 1700000000,
      validBefore: 1700000900,
    });
    expect(res.extensions?.paymentPermitContext?.meta.kind).toBe("PAYMENT_ONLY");
    expect(res.extensions?.paymentPermitContext?.meta.paymentId).toBe("req-123");
    expect(res.extensions?.paymentPermitContext?.meta.nonce).toBe(
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    );
    expect(res.extensions?.paymentPermitContext?.meta.validAfter).toBe(1700000000);
    expect(res.extensions?.paymentPermitContext?.meta.validBefore).toBe(1700000900);
    expect(res.accepts[0]).toEqual(representativeRequirements);
  });

  it("omits extensions when undefined", () => {
    const res = buildX402PaymentRequired(representativeRequirements, undefined);
    expect(res).not.toHaveProperty("extensions");
    expect(res.resource.url).toBe(representativeRequirements.resource);
    expect(res.accepts).toEqual([representativeRequirements]);
  });
});
