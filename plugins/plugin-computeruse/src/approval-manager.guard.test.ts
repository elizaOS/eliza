/**
 * Approval-mode guard tests validate untrusted strings received from disk or
 * the route layer before they can affect the computer-use safety gate.
 */
import { describe, expect, it } from "vitest";
import { isApprovalMode } from "./approval-manager.js";

describe("isApprovalMode", () => {
  it("accepts exactly the four real approval modes", () => {
    for (const m of ["full_control", "smart_approve", "approve_all", "off"]) {
      expect(isApprovalMode(m)).toBe(true);
    }
  });

  it("rejects unknown / malformed / case-variant strings", () => {
    for (const m of [
      "",
      "smart",
      "Smart_Approve",
      "FULL_CONTROL",
      "approve",
      "deny_all",
      "true",
      " off",
    ]) {
      expect(isApprovalMode(m)).toBe(false);
    }
  });
});
