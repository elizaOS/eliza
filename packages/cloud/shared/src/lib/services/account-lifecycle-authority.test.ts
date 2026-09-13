/** Verifies fail-closed account lifecycle classification. */

import { describe, expect, test } from "bun:test";
import {
  AccountLifecycleFencedError,
  type OrganizationLifecycleAuthority,
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

  test("each clause denies on its own, not only in combination", () => {
    // The composite fixture above flips state, active and deletionRequestId
    // together, so any ONE of the three could be deleted from the predicate
    // and it would still return false. Vary one field at a time against an
    // otherwise-allowed authority so each clause is pinned by itself.
    const allowed = {
      state: "active",
      revision: 7,
      active: true,
      deletionRequestId: null,
    } as const satisfies OrganizationLifecycleAuthority;

    expect(organizationLifecycleAllowsNewWork({ ...allowed })).toBe(true);

    for (const [label, authority] of [
      ["inactive organization", { ...allowed, active: false }],
      ["deletion_recovery state", { ...allowed, state: "deletion_recovery" }],
      ["deletion_irreversible state", { ...allowed, state: "deletion_irreversible" }],
      ["deletion receipt present", { ...allowed, deletionRequestId: "request-id" }],
    ] as const satisfies readonly (readonly [string, OrganizationLifecycleAuthority])[]) {
      expect(organizationLifecycleAllowsNewWork(authority), label).toBe(false);
    }
  });

  test("uses a non-identifying typed fence error", () => {
    expect(new AccountLifecycleFencedError()).toMatchObject({
      code: "ACCOUNT_LIFECYCLE_FENCED",
      message: "Account lifecycle does not authorize new provider or paid work",
    });
  });
});
