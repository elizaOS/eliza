import { describe, expect, it } from "vitest";
import {
  assertCreditRefundReservationPresent,
  CreditRefundReservationRequiredError,
} from "./credit-reconciliation-invariants.js";

describe("assertCreditRefundReservationPresent", () => {
  it("throws when refund positive without reservation", () => {
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: null,
        refundAmount: 10,
        refundTolerance: 1,
        scope: "org",
      }),
    ).toThrow(CreditRefundReservationRequiredError);
  });

  it("passes when reservation present", () => {
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: "tx-1",
        refundAmount: 10,
        refundTolerance: 1,
        scope: "org",
      }),
    ).not.toThrow();
  });

  it("passes when refund below tolerance (no-op)", () => {
    expect(() =>
      assertCreditRefundReservationPresent({
        reservationTransactionId: null,
        refundAmount: 0.5,
        refundTolerance: 1,
        scope: "org",
      }),
    ).not.toThrow();
  });

  it("error has code and context", () => {
    try {
      assertCreditRefundReservationPresent({
        reservationTransactionId: undefined,
        refundAmount: 5,
        refundTolerance: 1,
        scope: "my-scope",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(CreditRefundReservationRequiredError);
      expect((e as CreditRefundReservationRequiredError).name).toBe(
        "CreditRefundReservationRequiredError",
      );
      expect((e as { code: string }).code).toBe("CREDIT_REFUND_RESERVATION_REQUIRED");
    }
  });
});
