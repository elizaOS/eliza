import crypto from "node:crypto";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { approveRequestAction } from "../src/actions/approval.js";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createLifeOpsTestRuntime, type RealTestRuntimeResult } from "./helpers/runtime.js";

describe("approval dispatch integration", () => {
  let runtime: AgentRuntime;
  let testRuntime: RealTestRuntimeResult;

  beforeAll(async () => {
    testRuntime = await createLifeOpsTestRuntime();
    runtime = testRuntime.runtime;
  }, 180_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await testRuntime?.cleanup();
  });

  function ownerMessage(text: string): Memory {
    return {
      id: crypto.randomUUID() as UUID,
      entityId: runtime.agentId as UUID,
      roomId: crypto.randomUUID() as UUID,
      agentId: runtime.agentId as UUID,
      content: { text, source: "dashboard" },
    } as Memory;
  }

  it("approves and dispatches a queued cross-channel message request", async () => {
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    const request = await queue.enqueue({
      requestedBy: "test",
      subjectUserId: String(runtime.agentId),
      action: "send_message",
      payload: {
        action: "send_message",
        recipient: "telegram-room-frontier",
        body: "Sorry I missed you earlier. Thursday at 2pm works if that helps.",
        replyToMessageId: "frontier-source-message",
      },
      channel: "telegram",
      reason: "Repair missed call and reschedule.",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const sendSpy = vi
      .spyOn(LifeOpsService.prototype, "sendTelegramMessage")
      .mockResolvedValue({ ok: true });
    vi.spyOn(runtime, "useModel").mockResolvedValue(
      JSON.stringify({
        requestId: request.id,
        reason: "approve and send it",
      }),
    );

    const result = await approveRequestAction.handler?.(
      runtime,
      ownerMessage(`Approve request ${request.id} and send it.`) as never,
      undefined,
      undefined as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "telegram-room-frontier",
        message: "Sorry I missed you earlier. Thursday at 2pm works if that helps.",
      }),
    );
    expect((await queue.byId(request.id))?.state).toBe("done");
  });

  it("approves and dispatches a queued Gmail reply request", async () => {
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    const request = await queue.enqueue({
      requestedBy: "test",
      subjectUserId: String(runtime.agentId),
      action: "send_email",
      payload: {
        action: "send_email",
        to: [],
        cc: [],
        bcc: [],
        subject: "Frontier Tower repair",
        body: "Sorry I missed your call. Thursday at 2pm works if that helps.",
        threadId: "frontier-thread",
        replyToMessageId: "gmail-frontier-message",
      },
      channel: "email",
      reason: "Repair missed call and reschedule.",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const sendReplySpy = vi
      .spyOn(LifeOpsService.prototype, "sendGmailReply")
      .mockResolvedValue({ ok: true });
    vi.spyOn(runtime, "useModel").mockResolvedValue(
      JSON.stringify({
        requestId: request.id,
        reason: "approve and send the Gmail reply",
      }),
    );

    const result = await approveRequestAction.handler?.(
      runtime,
      ownerMessage(`Yes, approve ${request.id} and send the Gmail reply.`) as never,
      undefined,
      undefined as never,
      async () => {},
    );

    expect(result?.success).toBe(true);
    expect(sendReplySpy).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        messageId: "gmail-frontier-message",
        bodyText: "Sorry I missed your call. Thursday at 2pm works if that helps.",
        confirmSend: true,
      }),
    );
    expect((await queue.byId(request.id))?.state).toBe("done");
  });
});
