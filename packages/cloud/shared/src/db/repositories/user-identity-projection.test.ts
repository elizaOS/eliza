import { describe, expect, test } from "bun:test";
import { phoneVerifiedProjectionMatches } from "./user-identity-projection";

describe("phoneVerifiedProjectionMatches", () => {
  test("treats phoneless legacy false/NULL as coherent (#28646)", () => {
    expect(
      phoneVerifiedProjectionMatches(
        { phone_number: null, phone_verified: false },
        { phone_number: null, phone_verified: null },
      ),
    ).toBe(true);
  });

  test("still rejects verification drift when a phone number is present", () => {
    expect(
      phoneVerifiedProjectionMatches(
        { phone_number: "+15550100", phone_verified: true },
        { phone_number: "+15550100", phone_verified: null },
      ),
    ).toBe(false);
    expect(
      phoneVerifiedProjectionMatches(
        { phone_number: "+15550100", phone_verified: false },
        { phone_number: "+15550100", phone_verified: null },
      ),
    ).toBe(false);
  });

  test("rejects phoneless TRUE drift and phone number mismatch", () => {
    expect(
      phoneVerifiedProjectionMatches(
        { phone_number: null, phone_verified: true },
        { phone_number: null, phone_verified: null },
      ),
    ).toBe(false);
    expect(
      phoneVerifiedProjectionMatches(
        { phone_number: null, phone_verified: false },
        { phone_number: "+15550100", phone_verified: false },
      ),
    ).toBe(false);
  });
});
