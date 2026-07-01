import { describe, expect, it } from "vitest";
import { isApprovalMode } from "./approval-manager.js";

// #9105 computer-use — the approval mode persisted to disk / received over the
// API is an untrusted string; the guard is what keeps an invalid mode from
// silently disabling the safety gate. Pin every accepted + rejected value.
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
