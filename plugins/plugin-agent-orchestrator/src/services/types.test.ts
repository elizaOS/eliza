/**
 * Unit tests for orchestrator types: validates subscription authorization tokens.
 */
import { describe, expect, it } from "vitest";
import {
  createSubscriptionExecutionAuthorization,
  SUBSCRIPTION_EXECUTION_AUTHORIZATION_METADATA_KEY,
  subscriptionExecutionAuthorizationFromMetadata,
} from "./types.ts";

describe("orchestrator subscription execution authorization", () => {
  it("exports metadata key constant", () => {
    expect(SUBSCRIPTION_EXECUTION_AUTHORIZATION_METADATA_KEY).toBe(
      "subscriptionExecutionAuthorization",
    );
  });

  it("mints valid authorization object with TTL", () => {
    const now = Date.now();
    const auth = createSubscriptionExecutionAuthorization(
      "req-123",
      "sub-456",
      now,
    );
    expect(auth).toBeDefined();
    expect(auth?.version).toBe(1);
    expect(auth?.mode).toBe("user-attended");
    expect(auth?.requestId).toBe("req-123");
    expect(auth?.subjectId).toBe("sub-456");
    expect(auth?.issuedAtMs).toBe(now);
    expect(auth?.expiresAtMs).toBeGreaterThan(now);
  });

  it("returns undefined for empty requestId or subjectId", () => {
    expect(
      createSubscriptionExecutionAuthorization("", "sub-456"),
    ).toBeUndefined();
    expect(
      createSubscriptionExecutionAuthorization("req-123", "   "),
    ).toBeUndefined();
  });

  it("reads valid authorization from metadata record", () => {
    const now = Date.now();
    const auth = createSubscriptionExecutionAuthorization(
      "req-1",
      "sub-1",
      now,
    );
    const metadata = {
      [SUBSCRIPTION_EXECUTION_AUTHORIZATION_METADATA_KEY]: auth,
    };
    const parsed = subscriptionExecutionAuthorizationFromMetadata(
      metadata,
      now + 1000,
    );
    expect(parsed).toEqual(auth);
  });
});
