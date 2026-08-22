/** Verifies fail-closed account lifecycle classification. */

import { describe, expect, test } from "bun:test";
import {
  AccountLifecycleFencedError,
  organizationLifecycleAllowsNewWork,
} from "./account-lifecycle-authority";

describe("organization lifecycle provider authority", () => {
  test("allows only active state without a deletion receipt", () => {
    expect(
      organizationLifecycleAllowsNewWork({
        state: "active",
        revision: 7,
        active: true,
        deletionRequestId: null,
      }),
    ).toBe(true);
    expect(
      organizationLifecycleAllowsNewWork({
        state: "deletion_recovery",
        revision: 8,
        active: false,
        deletionRequestId: "request-id",
      }),
    ).toBe(false);
    expect(organizationLifecycleAllowsNewWork(null)).toBe(false);
  });

  test("uses a non-identifying typed fence error", () => {
    expect(new AccountLifecycleFencedError()).toMatchObject({
      code: "ACCOUNT_LIFECYCLE_FENCED",
      message: "Account lifecycle does not authorize new provider or paid work",
    });
  });
});
