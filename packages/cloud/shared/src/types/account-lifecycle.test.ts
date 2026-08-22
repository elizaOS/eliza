/** Verifies that account lifecycle operations cannot be conflated by clients. */

import { describe, expect, test } from "bun:test";
import { ACCOUNT_LIFECYCLE_OPERATION_CONTRACTS } from "./account-lifecycle";

describe("account lifecycle operation contracts", () => {
  test("defines four separate authorities and consequences", () => {
    expect(Object.keys(ACCOUNT_LIFECYCLE_OPERATION_CONTRACTS).sort()).toEqual([
      "agent_control",
      "personal_account_deletion",
      "shared_member_exit",
      "subscription_cancellation",
    ]);
    expect(
      ACCOUNT_LIFECYCLE_OPERATION_CONTRACTS.agent_control.recentAuthRequired,
    ).toBe(false);
    expect(
      ACCOUNT_LIFECYCLE_OPERATION_CONTRACTS.personal_account_deletion
        .explicitlyDoesNot,
    ).toContain("delete a shared organization");
    expect(
      ACCOUNT_LIFECYCLE_OPERATION_CONTRACTS.shared_member_exit
        .explicitlyDoesNot,
    ).toContain("leave the organization without an owner");
  });
});
