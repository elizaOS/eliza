/** Exercises purchaser request parsing against forged payment authority and lossy numeric input. */

import { describe, expect, test } from "bun:test";
import {
  createAppBillingCheckoutInput,
  startAppBillingTrialInput,
  updateAppBillingSubscriptionInput,
} from "./generic-billing-input";

const trial = {
  idempotencyKey: "trial-attempt-0001",
  expectedSubscriptionRevision: null,
  planRevisionId: "5048e3fb-5177-40e8-bde8-6d915926be6b",
  quantity: 1,
};

describe("app billing request authority", () => {
  test("rejects browser-supplied payment amounts, provider identities and return destinations", () => {
    for (const injected of [
      { amountCents: 1 },
      { stripeCustomerId: "cus_other" },
      { merchantId: "other-merchant" },
      { successUrl: "https://attacker.example" },
      { eligibilityPrincipalId: "new-identity" },
      { trialEndsAt: "2099-01-01T00:00:00Z" },
    ]) {
      expect(
        createAppBillingCheckoutInput.safeParse({
          ...trial,
          billingConsent: "accepted",
          ...injected,
        }).success,
      ).toBe(false);
    }
  });

  test("does not collapse distinct lifecycle revisions through floating-point conversion", () => {
    expect(
      startAppBillingTrialInput.parse({
        ...trial,
        expectedSubscriptionRevision: "9007199254740991",
      }).expectedSubscriptionRevision,
    ).toBe(Number.MAX_SAFE_INTEGER);
    for (const revision of ["9007199254740992", "9007199254740993", "1e3", "01", "-1", "0", 1]) {
      expect(
        startAppBillingTrialInput.safeParse({ ...trial, expectedSubscriptionRevision: revision })
          .success,
      ).toBe(false);
    }
  });

  test("rejects nonfinite, fractional and out-of-range seat quantities before provider I/O", () => {
    for (const quantity of [NaN, Infinity, -1, 0, 1.5, 2_147_483_648]) {
      expect(startAppBillingTrialInput.safeParse({ ...trial, quantity }).success).toBe(false);
    }
  });

  test("an update requires a reviewed quote and explicit recurring billing consent", () => {
    const request = {
      ...trial,
      expectedSubscriptionRevision: "1",
      quoteId: "3bde2151-c2d8-4c59-a9f5-a9db57e50a90",
    };
    expect(updateAppBillingSubscriptionInput.safeParse(request).success).toBe(false);
    const accepted = updateAppBillingSubscriptionInput.parse({
      ...request,
      billingConsent: "accepted",
    });
    expect(accepted.expectedSubscriptionRevision).toBe(1);
    expect(accepted.idempotencyKey).toBe(trial.idempotencyKey);
  });
});
