/**
 * Verifies the deterministic subscription funding classification and logical
 * operation-key boundary without a database or provider mock.
 */

import { describe, expect, test } from "bun:test";
import {
  createSubscriptionFundingPolicy,
  SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION,
  SUBSCRIPTION_FUNDING_CLASSES,
} from "./subscription-funding-policy";

describe("subscription funding policy", () => {
  test("keeps the public funding vocabulary closed", () => {
    expect(SUBSCRIPTION_FUNDING_CLASSES).toEqual(["allowance_eligible", "cash_only"]);
    expect(new Set(Object.values(SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION))).toEqual(
      new Set(SUBSCRIPTION_FUNDING_CLASSES),
    );
  });

  test("derives allowance eligibility from the server-owned operation", () => {
    expect(createSubscriptionFundingPolicy("ai_inference", "request:req-1")).toEqual({
      operation: "ai_inference",
      fundingClass: "allowance_eligible",
      logicalOperationKey: "request:req-1",
    });
    expect(createSubscriptionFundingPolicy("domain", "domain-order:order-1")).toEqual({
      operation: "domain",
      fundingClass: "cash_only",
      logicalOperationKey: "domain-order:order-1",
    });
  });

  test("defaults explicitly unclassified debits to purchased cash", () => {
    expect(createSubscriptionFundingPolicy("unclassified", "legacy:transaction-1")).toEqual({
      operation: "unclassified",
      fundingClass: "cash_only",
      logicalOperationKey: "legacy:transaction-1",
    });
  });

  test("rejects short, malformed, and oversized logical operation keys", () => {
    expect(() => createSubscriptionFundingPolicy("storage", "short")).toThrow(
      "Subscription funding logical operation key is invalid",
    );
    expect(() => createSubscriptionFundingPolicy("storage", "request key with spaces")).toThrow(
      "Subscription funding logical operation key is invalid",
    );
    expect(() => createSubscriptionFundingPolicy("storage", `r${"x".repeat(128)}`)).toThrow(
      "Subscription funding logical operation key is invalid",
    );
  });

  test("accepts the exact logical operation key length bounds", () => {
    expect(createSubscriptionFundingPolicy("storage", "r1234567").logicalOperationKey).toBe(
      "r1234567",
    );
    const maximumKey = `r${"x".repeat(127)}`;
    expect(createSubscriptionFundingPolicy("storage", maximumKey).logicalOperationKey).toBe(
      maximumKey,
    );
  });
});
