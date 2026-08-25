/**
 * Approval-mode guard tests validate untrusted strings received from disk or
 * the route layer before they can affect the computer-use safety gate.
 */
import { describe, expect, it } from "vitest";
import {
  ComputerUseApprovalManager,
  isApprovalMode,
} from "./approval-manager.js";

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

describe("ComputerUseApprovalManager cancellation", () => {
  it("removes and rejects a pending approval when its owner aborts", async () => {
    const manager = new ComputerUseApprovalManager();
    const controller = new AbortController();
    const pending = manager.requestApproval(
      "click",
      { coordinate: [10, 20] },
      controller.signal,
    );
    expect(manager.getSnapshot().pendingCount).toBe(1);
    controller.abort(new Error("session stopped"));
    await expect(pending).resolves.toMatchObject({
      approved: false,
      cancelled: true,
    });
    expect(manager.getSnapshot().pendingCount).toBe(0);
  });
});
