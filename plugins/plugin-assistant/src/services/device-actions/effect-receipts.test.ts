/** The receipt a proposal that ended without running records: its state first,
 * and "never ran" only when no execution was ever claimed. */
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../approval/types.ts";
import { deviceActionEffectReceipts } from "./effect-receipts.ts";

const at = new Date("2026-11-22T23:00:00.000Z");
const request = (
  state: ApprovalRequest["state"],
  execution: ApprovalRequest["execution"] = null,
) =>
  ({
    id: "f0000000-0000-4000-8000-000000000001",
    idempotencyKey: `device:${"7".repeat(64)}`,
    state,
    execution,
    expiresAt: at,
    createdAt: at,
    updatedAt: at,
    payload: {
      action: "device_action",
      version: 1,
      installationId: "installation",
      enrollmentId: "enrollment",
      requestMessageId: "request",
      operation: {
        type: "sms_compose",
        query: "Sam",
        body: "The keys are under the mat.",
      },
    },
  }) as unknown as ApprovalRequest;
const reason = (value: ApprovalRequest) => {
  const [receipt] = deviceActionEffectReceipts({
    request: value,
    reused: true,
  });
  expect(receipt).toMatchObject({
    operation: "device.sms_compose",
    resource: { kind: "device.approval", id: value.id },
    outcome: "noop",
  });
  return receipt.outcome === "noop" ? receipt.reason : undefined;
};

describe("ended proposal receipts", () => {
  it("states a rejection or expiry first and that it never ran", () => {
    expect(reason(request("rejected"))).toBe(
      "Rejected by the owner on the phone; it never ran.",
    );
    expect(reason(request("expired"))).toBe("Expired; it never ran.");
  });

  it("never says never ran for a claimed attempt or an unfinished proposal", () => {
    const claimed = {
      attemptId: "attempt",
      provider: "device",
      providerIdempotencyKey: "provider-key",
      claimedAt: at,
      providerReceipt: null,
    } as unknown as ApprovalRequest["execution"];
    expect(reason(request("rejected", claimed))).toBe(
      "No verified completed device effect is available; durable proposal state is rejected.",
    );
    expect(reason(request("approved"))).toBe(
      "No verified completed device effect is available; durable proposal state is approved.",
    );
  });
});
