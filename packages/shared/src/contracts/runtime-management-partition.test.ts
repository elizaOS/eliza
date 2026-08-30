/** Pins the security partition between owner-approval-exempt and mutating runtime operations. */

import { describe, expect, it } from "vitest";
import {
  RUNTIME_MANAGEMENT_OPERATIONS,
  RUNTIME_MANAGEMENT_OWNER_APPROVAL_EXEMPT_OPERATIONS,
} from "./runtime-management.ts";

const CONFIRMATION_REQUIRED_OPERATIONS = [
  "pair",
  "create_pairing",
  "claim_pairing",
  "confirm_pairing",
  "deny_pairing",
  "revoke",
  "remove",
  "retry",
  "connect_ssh",
  "add_direct",
  "enroll_host",
  "approve_pairing",
  "start_host",
  "stop_host",
  "revoke_host",
] as const;

describe("runtime-management owner-approval partition", () => {
  it("pins the exempt set and its exact confirmation-required complement", () => {
    const exempt = new Set(RUNTIME_MANAGEMENT_OWNER_APPROVAL_EXEMPT_OPERATIONS);

    expect([...exempt].sort()).toEqual(["inspect_ssh", "list"]);
    expect(
      [...exempt].every((operation) =>
        RUNTIME_MANAGEMENT_OPERATIONS.includes(operation),
      ),
    ).toBe(true);
    expect(
      RUNTIME_MANAGEMENT_OPERATIONS.filter(
        (operation) => !exempt.has(operation),
      ),
    ).toEqual(CONFIRMATION_REQUIRED_OPERATIONS);
  });
});
