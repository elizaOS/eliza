/**
 * Settlement math and dispatch-failure recognition for the inference admission
 * gate. These decide how much of a request is charged against a real credit
 * balance versus consumed conservatively at the gate, so every branch is
 * asserted on its own rather than through one representative case.
 *
 * Mock-free: this surface is pure and reaches no database, cache or Durable
 * Object.
 */

import { describe, expect, test } from "bun:test";
import type { CreditReconciliationResult } from "./credits";
import {
  collectedInferenceCost,
  InferenceAdmissionDispatchMarkError,
  InferenceAdmissionGateUnavailableError,
  type InferenceAdmissionLease,
  InferenceAdmissionLeaseRejectedError,
  inferenceSettlementAmounts,
  isInferenceAdmissionDispatchMarkError,
} from "./inference-admission-gate";

function lease(estimatedCostUsd: number): InferenceAdmissionLease {
  return {
    organizationId: "org-1",
    requestId: "req-1",
    estimatedCostUsd,
    gate: {} as InferenceAdmissionLease["gate"],
    providerDispatched: false,
  };
}

function reconciliation(
  overrides: Partial<CreditReconciliationResult> = {},
): CreditReconciliationResult {
  return {
    reservedAmount: 1,
    actualCost: 1,
    settlementTransactionIds: [],
    adjustmentType: "none",
    ...overrides,
  };
}

describe("collectedInferenceCost", () => {
  test("without reconciliation the estimate is a floor, never a ceiling", () => {
    // The gate already consumed the estimate, so an under-run cannot refund it.
    expect(collectedInferenceCost(lease(0.5), 0.2, null)).toBe(0.5);
    expect(collectedInferenceCost(lease(0.5), 0.9, null)).toBe(0.9);
    expect(collectedInferenceCost(lease(0.5), 0.5, null)).toBe(0.5);
  });

  test("an uncollected overage keeps that same floor rather than trusting the debit", () => {
    const uncollected = reconciliation({ adjustmentType: "uncollected_overage" });
    expect(collectedInferenceCost(lease(0.5), 0.2, uncollected)).toBe(0.5);
    expect(collectedInferenceCost(lease(0.5), 0.9, uncollected)).toBe(0.9);
  });

  test("a reported collectedAmount wins over both the estimate and the actual", () => {
    const collected = reconciliation({ collectedAmount: 0.3 });
    // Below the estimate and below the actual: the authoritative debit decides.
    expect(collectedInferenceCost(lease(0.5), 0.9, collected)).toBe(0.3);
  });

  test("collectedAmount of exactly zero is reported, not treated as absent", () => {
    // `!== undefined` rather than truthiness: a zero-collection replay must not
    // silently fall through to the estimate.
    expect(collectedInferenceCost(lease(0.5), 0.9, reconciliation({ collectedAmount: 0 }))).toBe(0);
  });

  test("with reconciliation but no collectedAmount the actual is used as-is", () => {
    // Note this is NOT floored by the estimate — the reconciled path is trusted.
    expect(collectedInferenceCost(lease(0.5), 0.2, reconciliation())).toBe(0.2);
  });

  test("rejects a non-finite or negative actual cost", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      expect(() => collectedInferenceCost(lease(0.5), bad, null)).toThrow(
        InferenceAdmissionGateUnavailableError,
      );
    }
    expect(collectedInferenceCost(lease(0), 0, null)).toBe(0);
  });

  test("rejects a non-finite or negative collectedAmount", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        collectedInferenceCost(lease(0.5), 0.2, reconciliation({ collectedAmount: bad })),
      ).toThrow(/collectedAmount/);
    }
  });
});

describe("inferenceSettlementAmounts", () => {
  test("with no reconciliation both halves are the gate-consumed amount", () => {
    expect(inferenceSettlementAmounts(lease(0.5), 0.2, null)).toEqual({
      balanceBackedUsd: 0.2,
      gateConsumedUsd: 0.5,
    });
  });

  test("a reported collectedAmount backs the balance and the gate alike", () => {
    expect(
      inferenceSettlementAmounts(lease(0.5), 0.9, reconciliation({ collectedAmount: 0.3 })),
    ).toEqual({ balanceBackedUsd: 0.3, gateConsumedUsd: 0.3 });
  });

  test("an uncollected overage caps the balance-backed half at the reservation", () => {
    // The gate consumes the full floor, but only the reserved amount was ever
    // actually backed by credits — the difference is the uncollected overage.
    expect(
      inferenceSettlementAmounts(
        lease(0.5),
        0.9,
        reconciliation({ adjustmentType: "uncollected_overage", reservedAmount: 0.4 }),
      ),
    ).toEqual({ balanceBackedUsd: 0.4, gateConsumedUsd: 0.9 });
  });

  test("an uncollected overage never reports more backed than consumed", () => {
    // reservedAmount above the consumed total must clamp, not inflate.
    expect(
      inferenceSettlementAmounts(
        lease(0.5),
        0.2,
        reconciliation({ adjustmentType: "uncollected_overage", reservedAmount: 10 }),
      ),
    ).toEqual({ balanceBackedUsd: 0.5, gateConsumedUsd: 0.5 });
  });

  test("a plain reconciliation backs the actual while the gate keeps its floor", () => {
    expect(inferenceSettlementAmounts(lease(0.5), 0.2, reconciliation())).toEqual({
      balanceBackedUsd: 0.2,
      gateConsumedUsd: 0.2,
    });
  });

  test("rejects a non-finite reservedAmount on the uncollected-overage path", () => {
    expect(() =>
      inferenceSettlementAmounts(
        lease(0.5),
        0.9,
        reconciliation({ adjustmentType: "uncollected_overage", reservedAmount: Number.NaN }),
      ),
    ).toThrow(/reservedAmount/);
  });

  test("balance-backed never exceeds gate-consumed on any branch", () => {
    const cases: Array<[number, CreditReconciliationResult | null]> = [
      [0.2, null],
      [0.9, null],
      [0.2, reconciliation()],
      [0.9, reconciliation({ collectedAmount: 0.3 })],
      [0.9, reconciliation({ adjustmentType: "uncollected_overage", reservedAmount: 0.4 })],
      [0.2, reconciliation({ adjustmentType: "uncollected_overage", reservedAmount: 10 })],
    ];
    for (const [actual, rec] of cases) {
      const { balanceBackedUsd, gateConsumedUsd } = inferenceSettlementAmounts(
        lease(0.5),
        actual,
        rec,
      );
      expect(balanceBackedUsd).toBeLessThanOrEqual(gateConsumedUsd);
    }
  });
});

describe("isInferenceAdmissionDispatchMarkError", () => {
  test("recognizes the error directly and through a cause chain", () => {
    const dispatch = new InferenceAdmissionDispatchMarkError("mark failed");
    expect(isInferenceAdmissionDispatchMarkError(dispatch)).toBe(true);
    expect(isInferenceAdmissionDispatchMarkError(new Error("wrapped", { cause: dispatch }))).toBe(
      true,
    );
    expect(
      isInferenceAdmissionDispatchMarkError(
        new Error("outer", { cause: new Error("inner", { cause: dispatch }) }),
      ),
    ).toBe(true);
  });

  test("does not treat the base unavailable error as a dispatch failure", () => {
    // The subclass carries a different settlement rule, so the parent must not
    // match — otherwise every gate outage would settle as zero.
    expect(
      isInferenceAdmissionDispatchMarkError(new InferenceAdmissionGateUnavailableError()),
    ).toBe(false);
  });

  test("returns false for non-errors and empty chains", () => {
    for (const value of [undefined, null, "dispatch", 42, {}, new Error("plain")]) {
      expect(isInferenceAdmissionDispatchMarkError(value)).toBe(false);
    }
  });

  test("stops at the depth limit rather than walking forever", () => {
    // 12 hops are inspected; a dispatch error buried deeper is not found.
    const buildChain = (depth: number): Error => {
      let error: Error = new InferenceAdmissionDispatchMarkError("deep");
      for (let index = 0; index < depth; index += 1) {
        error = new Error(`wrap-${index}`, { cause: error });
      }
      return error;
    };
    expect(isInferenceAdmissionDispatchMarkError(buildChain(11))).toBe(true);
    expect(isInferenceAdmissionDispatchMarkError(buildChain(12))).toBe(false);
  });

  test("terminates on a cyclic cause chain instead of hanging", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    (first as { cause?: unknown }).cause = second;
    expect(isInferenceAdmissionDispatchMarkError(first)).toBe(false);
  });
});

describe("InferenceAdmissionLeaseRejectedError", () => {
  test("keeps both amounts as fields and renders them at four decimals", () => {
    const error = new InferenceAdmissionLeaseRejectedError(1.23456, 0.5);
    expect(error.requiredUsd).toBe(1.23456);
    expect(error.availableUsd).toBe(0.5);
    expect(error.name).toBe("InferenceAdmissionLeaseRejectedError");
    expect(error.message).toBe(
      "Inference admission lease rejected. Required: $1.2346, Available: $0.5000",
    );
  });
});
