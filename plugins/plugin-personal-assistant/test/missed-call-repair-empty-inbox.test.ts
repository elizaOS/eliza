/**
 * Regression test for #13561.
 *
 * The LifeOps missed-call repair direct-message hook
 * (`handleLifeOpsMessageAction`, reached via `handleLifeOpsDirectMessageRequest`)
 * resolved the outbound `recipient` from the first matching unresolved inbox
 * triage entry:
 *
 *   const recipient =
 *     match?.sourceRoomId ?? match?.sourceEntityId ?? match?.channelName;
 *
 * When the inbox is empty (a fresh benchmark/agent context with no seeded
 * triage entries) `match` is `undefined`, so `recipient` is `undefined`. It
 * then enqueued a `send_message` approval with that undefined recipient, and
 * the ApprovalQueue's strict payload validator threw:
 *
 *   [ApprovalQueue] invalid enqueue payload.recipient: expected string
 *
 * That throw propagated out of the pre-LLM direct-message hook
 * (`runDirectMessageHooks` has no try/catch), crashing the whole turn BEFORE
 * any planner/model call. In the lifeops prompt benchmark this made the
 * `ea.followup.repair-missed-call-and-reschedule` case record `llmCalls: 0`
 * (and `latencyMs: 0`) deterministically across every variant — it never
 * executed and silently scored as failure.
 *
 * Fix: fail-closed but graceful — when no valid non-empty-string recipient can
 * be resolved, DO NOT enqueue a malformed approval. Return `null` so the turn
 * defers to the normal planner pipeline (which produces a real clarifying
 * reply, i.e. a real LLM call). These tests pin that behavior and prove the
 * still-valid seeded-recipient path continues to enqueue.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUnresolvedMock = vi.fn();
const enqueueMock = vi.fn();

vi.mock("../src/inbox/repository.js", () => ({
  InboxTriageRepository: class {
    getUnresolved = getUnresolvedMock;
  },
}));

vi.mock("../src/lifeops/approval-queue.js", () => ({
  createApprovalQueue: () => ({
    // Faithfully reproduce the real ApprovalQueue.enqueue validation contract:
    // a send_message payload whose recipient is not a non-empty string throws
    // the exact error the crash was caused by. Any valid enqueue returns a
    // synthetic request row so we don't need a DB in this unit test.
    enqueue: (input: { action: string; payload: { recipient?: unknown } }) => {
      enqueueMock(input);
      if (
        input.action === "send_message" &&
        typeof input.payload.recipient !== "string"
      ) {
        throw new Error(
          "[ApprovalQueue] invalid enqueue payload.recipient: expected string",
        );
      }
      return Promise.resolve({ id: "approval-1" });
    },
  }),
}));

// Import AFTER the mocks are registered so plugin.ts binds to the stubs.
const { handleLifeOpsDirectMessageRequest } = await import("../src/plugin.js");

const MISSED_CALL_TEXT =
  "I missed a call with the Frontier Tower guys today. Need to repair that and reschedule if possible asap, but hold the note for my approval first.";

function makeMessage(text: string): Memory {
  return {
    id: "msg-missed-call-1" as UUID,
    entityId: "owner-1" as UUID,
    roomId: "room-missed-call-1" as UUID,
    content: { text, source: "test" },
  } as Memory;
}

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-missed-call-test" as UUID,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  } as unknown as IAgentRuntime;
}

function makeState(): State {
  return { values: {}, data: {}, text: "" } as State;
}

describe("LifeOps missed-call repair — empty inbox no longer crashes the turn (#13561)", () => {
  beforeEach(() => {
    getUnresolvedMock.mockReset();
    enqueueMock.mockReset();
  });

  it("returns null (defers to the planner) instead of throwing when no recipient can be resolved", async () => {
    // Empty inbox: no unresolved triage entry -> no resolvable recipient.
    getUnresolvedMock.mockResolvedValue([]);

    const result = await handleLifeOpsDirectMessageRequest({
      runtime: makeRuntime(),
      message: makeMessage(MISSED_CALL_TEXT),
      state: makeState(),
    });

    // The hook must defer (return null) so the normal pipeline / planner runs
    // and produces a real reply — NOT throw and crash the turn pre-LLM.
    expect(result).toBeNull();
    // And it must NOT have attempted to enqueue a malformed approval.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("still enqueues a send_message approval with a valid recipient when a matching inbox entry exists", async () => {
    getUnresolvedMock.mockResolvedValue([
      {
        id: "triage-1",
        source: "gmail",
        sourceRoomId: "frontier-room",
        sourceEntityId: "frontier-entity",
        sourceMessageId: "frontier-missed-call",
        channelName: "Frontier Tower",
        snippet:
          "Sorry I missed your call earlier today. Can we reschedule the walkthrough this week?",
        senderName: "Frontier Tower",
        threadContext: null,
        suggestedResponse:
          "Sorry I missed your call earlier. Thursday at 2pm works for the walkthrough.",
      },
    ]);

    const result = await handleLifeOpsDirectMessageRequest({
      runtime: makeRuntime(),
      message: makeMessage(MISSED_CALL_TEXT),
      state: makeState(),
    });

    // The valid path still short-circuits with a queued-for-approval result.
    expect(result).not.toBeNull();
    expect(result?.success).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqueued = enqueueMock.mock.calls[0]?.[0] as {
      action: string;
      payload: { recipient: unknown };
    };
    expect(enqueued.action).toBe("send_message");
    // recipient falls through sourceRoomId -> sourceEntityId -> channelName;
    // here it resolves to the room id and MUST be a non-empty string.
    expect(typeof enqueued.payload.recipient).toBe("string");
    expect((enqueued.payload.recipient as string).length).toBeGreaterThan(0);
  });

  it("also defers when a matched entry has no room/entity id but channelName provides a valid recipient", async () => {
    // A matched entry with null room+entity but a real channelName must still
    // resolve a valid recipient (channelName is non-nullable) and enqueue.
    getUnresolvedMock.mockResolvedValue([
      {
        id: "triage-2",
        source: "telegram",
        sourceRoomId: null,
        sourceEntityId: null,
        sourceMessageId: null,
        channelName: "Frontier Tower",
        snippet: "missed walkthrough call",
        senderName: null,
        threadContext: null,
        suggestedResponse: null,
      },
    ]);

    const result = await handleLifeOpsDirectMessageRequest({
      runtime: makeRuntime(),
      message: makeMessage(MISSED_CALL_TEXT),
      state: makeState(),
    });

    expect(result).not.toBeNull();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqueued = enqueueMock.mock.calls[0]?.[0] as {
      payload: { recipient: unknown };
    };
    expect(enqueued.payload.recipient).toBe("Frontier Tower");
  });
});
