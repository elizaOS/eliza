/**
 * Deterministic coverage for the LifeOps approval/check-in [CHOICE] emitters:
 * chips parse through the real core interaction parser and every chip value
 * survives the connector reply-callback size cap. No model, no DB.
 */
import { describe, expect, it } from "vitest";
import { encodeReplyCallback } from "../../../packages/core/src/messaging/interactions/callback";
import { parseInteractionBlocks } from "../../../packages/core/src/messaging/interactions/parse";
import {
  appendCheckinAckChoiceMarker,
  buildApprovalChoiceText,
} from "../src/lifeops/choice-markers.js";

function choiceBlocks(text: string) {
  return parseInteractionBlocks(text).blocks.filter(
    (block) => block.kind === "choice",
  );
}

function expectConnectorSafeChoiceValues(text: string): void {
  for (const choice of choiceBlocks(text)) {
    if (choice.kind !== "choice") continue;
    for (const option of choice.options) {
      expect(encodeReplyCallback(option.value)).not.toBeNull();
    }
  }
}

describe("LifeOps choice markers", () => {
  it("renders approval queue questions with approve/deny chips resolved by RESOLVE_REQUEST", () => {
    const text = buildApprovalChoiceText({
      requestId: "req-123",
      reason: "Approve sending the email to JJ?",
      action: "send_email",
    });

    expectConnectorSafeChoiceValues(text);
    const [choice] = choiceBlocks(text);
    expect(choice).toMatchObject({
      kind: "choice",
      scope: "approval-req-123",
      id: "req-123",
      options: [
        { value: "approve req-123", label: "Approve" },
        { value: "reject req-123", label: "Deny" },
      ],
    });
  });

  it("appends check-in ack chips whose values are direct owner replies", () => {
    const text = appendCheckinAckChoiceMarker("Morning brief ready.", {
      reportId: "checkin-456",
      kind: "morning",
    });

    expectConnectorSafeChoiceValues(text);
    const [choice] = choiceBlocks(text);
    expect(choice).toMatchObject({
      kind: "choice",
      scope: "checkin-checkin-456",
      id: "checkin-456",
      options: [
        { value: "All good", label: "All good" },
        {
          value: "details checkin-456",
          label: "Show details",
        },
        { value: "snooze checkin-456", label: "Snooze" },
      ],
    });
  });
});
