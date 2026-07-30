/**
 * TASKS effect settlement tests the public action boundary with an ACP session
 * that accepts a follow-up but returns no provider receipt. The action must
 * preserve the real dispatch while refusing to describe that ambiguous outcome
 * as applied or encourage an unsafe automatic retry.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.ts";

const SESSION_ID = "session-without-provider-receipt";

function runtimeWithVoidSend(): {
  runtime: IAgentRuntime;
  sendToSession: ReturnType<typeof vi.fn>;
} {
  const session = {
    id: SESSION_ID,
    sessionId: SESSION_ID,
    agentType: "codex",
    name: "Receipt test",
    workdir: "/tmp/orchestrator-receipt-test",
    status: "ready",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    metadata: {},
  };
  const sendToSession = vi.fn(async () => undefined);
  const acp = {
    getSession: vi.fn(async (id: string) =>
      id === SESSION_ID ? session : undefined,
    ),
    listSessions: vi.fn(async () => [session]),
    sendToSession,
  };
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Receipt test" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn(() => undefined),
    getService: (type: string) =>
      type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
        ? acp
        : undefined,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return { runtime, sendToSession };
}

function message(): Memory {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    roomId: "22222222-2222-4222-8222-222222222222",
    entityId: "33333333-3333-4333-8333-333333333333",
    content: { text: "tell the coding agent to continue" },
  } as unknown as Memory;
}

describe("TASKS effect receipts", () => {
  it("opts the mixed operation surface into strict receipt delivery", () => {
    expect(tasksAction.tags).toContain("effect:receipt-required");
  });

  it("fails closed after a void ACP send instead of fabricating applied proof", async () => {
    const { runtime, sendToSession } = runtimeWithVoidSend();
    const replies: string[] = [];
    const result = await tasksAction.handler(
      runtime,
      message(),
      undefined as unknown as State,
      {
        parameters: {
          action: "send",
          sessionId: SESSION_ID,
          input: "Continue and verify the result.",
        },
      },
      async (content) => {
        if (typeof content.text === "string") replies.push(content.text);
        return [];
      },
    );

    expect(sendToSession).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
    });
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "failed",
        failure: {
          code: "AUTHORITATIVE_RECEIPT_MISSING",
          retryable: false,
          acceptance: "unknown",
        },
      }),
    ]);
    expect(
      result?.effectReceipts?.some((receipt) => receipt.outcome === "applied"),
    ).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("no authoritative commit receipt");
    expect(result?.userFacingText).toBe(replies[0]);
    expect(result?.userFacingEffectReceiptIds).toEqual([
      result?.effectReceipts?.[0]?.receiptId,
    ]);
  });

  it("binds non-empty action text without inventing a direct callback", async () => {
    const { runtime } = runtimeWithVoidSend();
    const callback = vi.fn(async () => []);
    const result = await tasksAction.handler(
      runtime,
      message(),
      undefined as unknown as State,
      { parameters: { action: "list_agents" } },
      callback,
    );

    expect(callback).not.toHaveBeenCalled();
    expect(result?.userFacingText).toBe(result?.text);
    expect(result?.verifiedUserFacing).toBe(true);
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({ outcome: "noop" }),
    ]);
    expect(result?.userFacingEffectReceiptIds).toEqual([
      result?.effectReceipts?.[0]?.receiptId,
    ]);
  });
});
