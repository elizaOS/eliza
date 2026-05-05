import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import type { ApprovalEnqueueInput } from "../src/lifeops/approval-queue.types.js";

const agentId = "00000000-0000-0000-0000-000000000003";

function createQueue() {
  return createApprovalQueue({ agentId } as IAgentRuntime, { agentId });
}

function baseInput(
  overrides: Partial<ApprovalEnqueueInput> = {},
): ApprovalEnqueueInput {
  return {
    requestedBy: "agent:lifeops",
    subjectUserId: "owner-123",
    action: "send_message",
    payload: {
      action: "send_message",
      recipient: "+15555551212",
      body: "Hello",
      replyToMessageId: null,
    },
    channel: "sms",
    reason: "confirm before sending",
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe("ApprovalQueue payload validation", () => {
  it("rejects malformed enqueue payloads before touching storage", async () => {
    const queue = createQueue();

    await expect(
      queue.enqueue(
        baseInput({
          payload: {
            action: "send_message",
            recipient: "+15555551212",
            replyToMessageId: null,
          } as ApprovalEnqueueInput["payload"],
        }),
      ),
    ).rejects.toThrow(/invalid enqueue payload\.body/);
  });

  it("rejects request and payload action mismatches", async () => {
    const queue = createQueue();

    await expect(
      queue.enqueue(
        baseInput({
          action: "send_email",
        }),
      ),
    ).rejects.toThrow(/payload action send_message does not match/);
  });
});
