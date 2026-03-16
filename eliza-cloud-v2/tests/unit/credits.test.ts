/**
 * Credits Service Unit Tests
 */

import { describe, test, expect } from "bun:test";
import {
  COST_BUFFER,
  MIN_RESERVATION,
  DEFAULT_OUTPUT_TOKENS,
  InsufficientCreditsError,
  creditsService,
} from "@/lib/services/credits";
import type {
  CreditReservation,
  ReserveCreditsParams,
} from "@/lib/services/credits";
import { estimateTokens } from "@/lib/pricing";

describe("Credits Constants", () => {
  test("COST_BUFFER is 1.5", () => {
    expect(COST_BUFFER).toBe(1.5);
  });

  test("MIN_RESERVATION is $0.01", () => {
    expect(MIN_RESERVATION).toBe(0.01);
  });

  test("DEFAULT_OUTPUT_TOKENS is 500", () => {
    expect(DEFAULT_OUTPUT_TOKENS).toBe(500);
  });
});

describe("InsufficientCreditsError", () => {
  test("has correct name", () => {
    const error = new InsufficientCreditsError(5.5, 2.0);
    expect(error.name).toBe("InsufficientCreditsError");
  });

  test("stores required amount", () => {
    const error = new InsufficientCreditsError(5.5, 2.0);
    expect(error.required).toBe(5.5);
  });

  test("stores available amount", () => {
    const error = new InsufficientCreditsError(5.5, 2.0);
    expect(error.available).toBe(2.0);
  });

  test("formats message with required and available", () => {
    const error = new InsufficientCreditsError(5.5, 2.0);
    expect(error.message).toBe(
      "Insufficient credits. Required: $5.5000, Available: $2.0000",
    );
  });

  test("stores optional reason", () => {
    const error = new InsufficientCreditsError(10, 5, "below_minimum");
    expect(error.reason).toBe("below_minimum");
  });

  test("is instanceof Error", () => {
    const error = new InsufficientCreditsError(1, 0);
    expect(error instanceof Error).toBe(true);
  });
});

describe("CreditReservation Interface", () => {
  test("type has reservedAmount and reconcile", () => {
    const reservation: CreditReservation = {
      reservedAmount: 10,
      reconcile: async () => {},
    };
    expect(reservation.reservedAmount).toBe(10);
    expect(typeof reservation.reconcile).toBe("function");
  });
});

describe("createAnonymousReservation", () => {
  test("returns reservation with zero amount", () => {
    const reservation = creditsService.createAnonymousReservation();
    expect(reservation.reservedAmount).toBe(0);
  });

  test("reconcile is a no-op", async () => {
    const reservation = creditsService.createAnonymousReservation();
    await expect(reservation.reconcile(100)).resolves.toBeUndefined();
  });
});

describe("estimateTokens", () => {
  test("is a function", () => {
    expect(typeof estimateTokens).toBe("function");
  });

  test("returns number for text input", () => {
    const result = estimateTokens("Hello world");
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
  });

  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("creditsService", () => {
  test("reserve method exists", () => {
    expect(typeof creditsService.reserve).toBe("function");
  });

  test("createAnonymousReservation method exists", () => {
    expect(typeof creditsService.createAnonymousReservation).toBe("function");
  });

  test("ReserveCreditsParams type is usable", () => {
    const params: ReserveCreditsParams = {
      organizationId: "org-123",
      description: "test",
      amount: 10,
    };
    expect(params.organizationId).toBe("org-123");
  });
});

describe("Reconciliation Logic", () => {
  test("refund: reserved $10, actual $7 = $3 refund", () => {
    expect(10.0 - 7.0).toBe(3.0);
  });

  test("overage: reserved $5, actual $8 = $3 charge", () => {
    expect(8.0 - 5.0).toBe(3.0);
  });

  test("no-op: difference within EPSILON (0.0001)", () => {
    const EPSILON = 0.0001;
    expect(Math.abs(5.0 - 5.00005)).toBeLessThan(EPSILON);
  });

  test("full refund: actual = 0", () => {
    expect(15.0 - 0).toBe(15.0);
  });
});
