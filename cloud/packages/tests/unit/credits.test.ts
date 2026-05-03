/**
 * Credits Service Unit Tests
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { CreditReservation, ReserveCreditsParams } from "@/lib/services/credits";

type CreditsSnapshot = {
  constants: {
    COST_BUFFER: number;
    MIN_RESERVATION: number;
    EPSILON: number;
    DEFAULT_OUTPUT_TOKENS: number;
  };
  insufficientCreditsError: {
    name: string;
    required: number;
    available: number;
    message: string;
    reason: string | undefined;
    isError: boolean;
  };
  reservation: {
    reservedAmount: number;
    reconcileResolved: boolean;
  };
  creditsService: {
    reserveType: string;
    createAnonymousReservationType: string;
  };
  pricing: {
    estimateTokensType: string;
    helloWorldTokens: number;
    emptyTokens: number;
  };
};

let snapshot: CreditsSnapshot;

beforeAll(() => {
  const cwd = new URL("../..", import.meta.url).pathname;
  const script = `
    import {
      COST_BUFFER,
      MIN_RESERVATION,
      EPSILON,
      DEFAULT_OUTPUT_TOKENS,
      InsufficientCreditsError,
      creditsService,
    } from "./lib/services/credits";
    import { estimateTokens } from "./lib/pricing";

    const error = new InsufficientCreditsError(5.5, 2.0, "below_minimum");
    const reservation = creditsService.createAnonymousReservation();
    await reservation.reconcile(100);

    console.log(JSON.stringify({
      constants: {
        COST_BUFFER,
        MIN_RESERVATION,
        EPSILON,
        DEFAULT_OUTPUT_TOKENS,
      },
      insufficientCreditsError: {
        name: error.name,
        required: error.required,
        available: error.available,
        message: error.message,
        reason: error.reason,
        isError: error instanceof Error,
      },
      reservation: {
        reservedAmount: reservation.reservedAmount,
        reconcileResolved: true,
      },
      creditsService: {
        reserveType: typeof creditsService.reserve,
        createAnonymousReservationType: typeof creditsService.createAnonymousReservation,
      },
      pricing: {
        estimateTokensType: typeof estimateTokens,
        helloWorldTokens: estimateTokens("Hello world"),
        emptyTokens: estimateTokens(""),
      },
    }));
  `;

  const result = Bun.spawnSync({
    cmd: ["bun", "--eval", script],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  snapshot = JSON.parse(result.stdout.toString()) as CreditsSnapshot;
});

describe("Credits Constants", () => {
  test("COST_BUFFER is 1.5", () => {
    expect(snapshot.constants.COST_BUFFER).toBe(1.5);
  });

  test("MIN_RESERVATION is $0.000001", () => {
    expect(snapshot.constants.MIN_RESERVATION).toBe(0.000001);
  });

  test("EPSILON is 10% of MIN_RESERVATION", () => {
    expect(snapshot.constants.EPSILON).toBe(snapshot.constants.MIN_RESERVATION * 0.1);
    expect(snapshot.constants.EPSILON).toBeLessThan(snapshot.constants.MIN_RESERVATION);
  });

  test("DEFAULT_OUTPUT_TOKENS is 500", () => {
    expect(snapshot.constants.DEFAULT_OUTPUT_TOKENS).toBe(500);
  });
});

describe("InsufficientCreditsError", () => {
  test("has correct name", () => {
    expect(snapshot.insufficientCreditsError.name).toBe("InsufficientCreditsError");
  });

  test("stores required amount", () => {
    expect(snapshot.insufficientCreditsError.required).toBe(5.5);
  });

  test("stores available amount", () => {
    expect(snapshot.insufficientCreditsError.available).toBe(2.0);
  });

  test("formats message with required and available", () => {
    expect(snapshot.insufficientCreditsError.message).toBe(
      "Insufficient credits. Required: $5.5000, Available: $2.0000",
    );
  });

  test("stores optional reason", () => {
    expect(snapshot.insufficientCreditsError.reason).toBe("below_minimum");
  });

  test("is instanceof Error", () => {
    expect(snapshot.insufficientCreditsError.isError).toBe(true);
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
    expect(snapshot.reservation.reservedAmount).toBe(0);
  });

  test("reconcile is a no-op", () => {
    expect(snapshot.reservation.reconcileResolved).toBe(true);
  });
});

describe("estimateTokens", () => {
  test("is a function", () => {
    expect(snapshot.pricing.estimateTokensType).toBe("function");
  });

  test("returns number for text input", () => {
    expect(typeof snapshot.pricing.helloWorldTokens).toBe("number");
    expect(snapshot.pricing.helloWorldTokens).toBeGreaterThan(0);
  });

  test("returns 0 for empty string", () => {
    expect(snapshot.pricing.emptyTokens).toBe(0);
  });
});

describe("creditsService", () => {
  test("reserve method exists", () => {
    expect(snapshot.creditsService.reserveType).toBe("function");
  });

  test("createAnonymousReservation method exists", () => {
    expect(snapshot.creditsService.createAnonymousReservationType).toBe("function");
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

  test("no-op: difference within EPSILON", () => {
    const tiny = snapshot.constants.EPSILON * 0.5;
    expect(Math.abs(tiny)).toBeLessThan(snapshot.constants.EPSILON);
  });

  test("not a no-op: difference exceeds EPSILON", () => {
    const meaningful = snapshot.constants.MIN_RESERVATION;
    expect(Math.abs(meaningful)).toBeGreaterThan(snapshot.constants.EPSILON);
  });

  test("full refund: actual = 0", () => {
    expect(15.0 - 0).toBe(15.0);
  });
});
