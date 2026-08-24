/**
 * Unit tests for credit reconciliation invariants.
 * Validates exact economic boundaries, tolerance thresholds, blank reservation ID handling,
 * and typed CreditRefundReservationRequiredError code, context, and severity contracts.
 */

import { describe, expect, it } from "vitest";
import {
  assertCreditRefundReservationPresent,
  CreditRefundReservationRequiredError,
} from "./credit-reconciliation-invariants.js";

describe("assertCreditRefundReservationPresent", () => {
  it("throws CreditRefundReservationRequiredError when refund equals or exceeds tolerance without reservation", () => {
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: null,
        refundAmount: 10,
        refundTolerance: 1,
        scope: "org-billing",
      }),
    ).toThrow(CreditRefundReservationRequiredError);
  });

  it("passes when valid non-empty reservation transaction ID is present", () => {
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: "tx-res-12345",
        refundAmount: 10,
        refundTolerance: 1,
        scope: "org-billing",
      }),
    ).not.toThrow();
  });

  it("rejects blank, empty, and whitespace reservation IDs when refund meets tolerance", () => {
    for (const blankId of [null, undefined, "", "   ", "\t\n"]) {
      expect(() =>
        assertCreditRefundReservationPresent({
          reservationTransactionId: blankId,
          refundAmount: 5,
          refundTolerance: 1,
          scope: "org-billing",
        }),
      ).toThrow(CreditRefundReservationRequiredError);
    }
  });

  it("enforces exact economic tolerance boundary", () => {
    const tolerance = 1.0;

    // Exactly at tolerance: requires reservation, must throw without one
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: null,
        refundAmount: tolerance,
        refundTolerance: tolerance,
        scope: "org-billing",
      }),
    ).toThrow(CreditRefundReservationRequiredError);

    // Smallest representable float below tolerance: allowed without reservation
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: null,
        refundAmount: tolerance - Number.EPSILON,
        refundTolerance: tolerance,
        scope: "org-billing",
      }),
    ).not.toThrow();

    // Smallest representable float above tolerance: requires reservation
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: null,
        refundAmount: tolerance + Number.EPSILON,
        refundTolerance: tolerance,
        scope: "org-billing",
      }),
    ).toThrow(CreditRefundReservationRequiredError);
  });

  it("verifies typed error properties, code, context, and fatal severity", () => {
    let capturedError: unknown;
    try {
      assertCreditRefundReservationPresent({
        reservationTransactionId: undefined,
        refundAmount: 42.5,
        refundTolerance: 0.1,
        scope: "app-settlement",
      });
    } catch (err) {
      capturedError = err;
    }

    expect(capturedError).toBeInstanceOf(CreditRefundReservationRequiredError);
    const error = capturedError as CreditRefundReservationRequiredError;
    expect(error.name).toBe("CreditRefundReservationRequiredError");
    expect(error.code).toBe("CREDIT_REFUND_RESERVATION_REQUIRED");
    expect(error.severity).toBe("fatal");
    expect(error.context).toEqual({
      scope: "app-settlement",
      refundAmount: 42.5,
    });
    expect(error.message).toContain(
      "app-settlement requires an authoritative reservation for a positive refund",
    );
  });
});
