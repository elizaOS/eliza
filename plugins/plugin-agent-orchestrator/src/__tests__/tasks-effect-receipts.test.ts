/**
 * TASKS effect settlement tests the public action boundary with an ACP session
 * that accepts a follow-up but returns no provider receipt. The action must
 * preserve the real dispatch while refusing to describe that ambiguous outcome
 * as applied or encourage an unsafe automatic retry.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { tasksAction } from "../actions/tasks.ts";
import { CodingWorkspaceService } from "../services/workspace-service.ts";

const SESSION_ID = "session-without-provider-receipt";

function runtimeWithVoidSend(sendResult: unknown = undefined): {
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
  const sendToSession = vi.fn(async () => sendResult);
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
    // The unconfirmed-outcome hedge is planner grounding, deliberately NOT
    // granted the do-not-paraphrase license: shipping it verbatim buried the
    // evaluator's in-voice reply under mechanism prose (live 2026-08-20).
    expect(result).toMatchObject({ success: true });
    expect(result?.verifiedUserFacing).toBeUndefined();
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
    // Receipt settlement provides canonical planner input without leaking a
    // raw tool callback; the turn evaluator remains the sole visible voice.
    expect(replies).toEqual([]);
    // The unconfirmed-outcome projection is model-phrased with a factual
    // fallback (this runtime has no model) and carries no internal
    // receipt/commit vocabulary.
    // The hedge lives on planner-facing `text` now; userFacingText and the
    // receipt binding are deliberately absent (see the license note above).
    expect(result?.userFacingText).toBeUndefined();
    expect(String(result?.text)).toContain("could not confirm");
    expect(String(result?.text)).not.toMatch(/receipt|commit/i);
    expect(result?.userFacingEffectReceiptIds).toBeUndefined();
  });

  it("settles a send the session ran to a stop as provider-accepted", async () => {
    const { runtime, sendToSession } = runtimeWithVoidSend({
      sessionId: SESSION_ID,
      response: "done",
      finalText: "done",
      stopReason: "end_turn",
      durationMs: 12,
    });
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
      async () => [],
    );

    expect(sendToSession).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true });
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "applied",
        resource: { kind: "acp.session", id: SESSION_ID },
        commit: expect.objectContaining({ kind: "provider_accepted" }),
      }),
    ]);
    expect(String(result?.text)).toBe("Sent input to agent");
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
    // list_agents is a planner-only read (#18315): its text is planner
    // observation, never a verbatim user reply, so no user-facing projection
    // or do-not-paraphrase license is attached.
    expect(result?.text?.trim()).toBeTruthy();
    expect(result?.userFacingText).toBeUndefined();
    expect(result?.verifiedUserFacing).toBeUndefined();
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({ outcome: "noop" }),
    ]);
    expect(result?.userFacingEffectReceiptIds).toBeUndefined();
  });

  it("settles add_labels as applied only from the authoritative issue readback", async () => {
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
      character: { name: "Receipt test" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: vi.fn(() => undefined),
      reportError: vi.fn(),
    } as unknown as IAgentRuntime;
    const workspace = new CodingWorkspaceService(runtime, {
      baseDir: "/tmp/orchestrator-receipt-test",
    });
    workspace.addLabels = vi.fn(async () => ({
      number: 7,
      url: "https://github.com/acme/widgets/issues/7",
      state: "open" as const,
      title: "Widget",
      body: "",
      labels: ["triage", "p1"],
      assignees: [],
      createdAt: new Date(0),
    }));
    runtime.getService = ((type: string) =>
      type === CodingWorkspaceService.serviceType
        ? workspace
        : undefined) as IAgentRuntime["getService"];
    const result = await tasksAction.handler(
      runtime,
      { ...message(), entityId: runtime.agentId } as Memory,
      undefined as unknown as State,
      {
        parameters: {
          action: "manage_issues",
          issueAction: "add_labels",
          repo: "acme/widgets",
          issueNumber: 7,
          labels: ["triage", "p1"],
        },
      },
      async () => [],
    );

    expect(workspace.addLabels).toHaveBeenCalledWith("acme/widgets", 7, [
      "triage",
      "p1",
    ]);
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "applied",
        resource: {
          kind: "github.issue",
          id: "https://github.com/acme/widgets/issues/7",
        },
        commit: expect.objectContaining({
          kind: "provider_accepted",
          id: "https://github.com/acme/widgets/issues/7",
        }),
      }),
    ]);
  });
});
