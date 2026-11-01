/** PREPARED real-wrapper regressions; not imported/executed under the hold. */
import {
  beginRequestOperationAttempt,
  bindTaskExtractionContext,
  checkBoundNotesOperation,
  commitNotesRequestRestriction,
  createModelAttemptAllowance,
  getStreamingContext,
  type IAgentRuntime,
  type Memory,
  runWithStreamingContext,
  runWithSuppressedModelStream,
  type State,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { beginStage1NotesRequestIssuer } from "./notes-request-issuer";

function input() {
  const runtime = { agentId: "agent" } as IAgentRuntime;
  const message = {
    id: "message",
    agentId: "agent",
    roomId: "room",
    entityId: "owner",
    content: { text: "write a note" },
  } as Memory;
  const state = { values: {}, data: {}, text: "" } as State;
  const context = {
    id: "turn",
    metadata: { messageId: message.id, roomId: message.roomId },
    events: [],
  };
  return { runtime, message, state, context };
}

it("retains a requested mutation through the actual bounded suppression wrapper", async () => {
  const f = input(),
    root = new AbortController();
  const allowance = createModelAttemptAllowance({
    signal: root.signal,
    budgetMicroUsd: 1000,
    maxAttempts: 2,
    maxOutputTokens: 32,
    expiresAt: Date.now() + 60_000,
    tariffs: [
      {
        provider: "fake",
        model: "fake",
        route: "fake",
        inputNanoUsdPerToken: 1,
        outputNanoUsdPerToken: 1,
        inputTokenUpperBound: 100,
      },
    ],
  });
  const lease = allowance.openTurn(String(f.message.id), root.signal);
  try {
    await runWithStreamingContext(
      {
        messageId: String(f.message.id),
        abortSignal: root.signal,
        modelAttemptLease: lease,
        modelAttemptTurnId: String(f.message.id),
        onStreamChunk: async () => undefined,
      },
      async () => {
        const issuer = beginStage1NotesRequestIssuer(f.runtime, f.message);
        if (!issuer) throw Error("Host issuer missing");
        const source = { actualClassifierInput: "current request" };
        commitNotesRequestRestriction(issuer, {
          classification: "mutation_requested",
          source,
          currentSource: () => source,
        });
        bindTaskExtractionContext(
          f.state,
          f.message,
          f.context,
          f.context,
          f.runtime,
          issuer,
        );
        const attempt = beginRequestOperationAttempt(f);
        await runWithSuppressedModelStream(async () => {
          // The existing wrapper creates a NEW composite AbortSignal. Stable
          // custody, not that signal's reference, preserves the request.
          expect(getStreamingContext()?.abortSignal).not.toBe(root.signal);
          expect(
            checkBoundNotesOperation(f.state, f.message, "create", attempt),
          ).toEqual({ allowed: true, addsAuthority: false });
        });
        root.abort();
        expect(
          checkBoundNotesOperation(f.state, f.message, "create", attempt),
        ).toMatchObject({
          allowed: false,
          code: "REQUEST_OPERATION_UNRESOLVED",
        });
      },
    );
  } finally {
    allowance.close();
  }
});

it("does not mint an issuer from a missing host request signal", () => {
  const f = input();
  runWithStreamingContext({ messageId: String(f.message.id) }, () => {
    expect(beginStage1NotesRequestIssuer(f.runtime, f.message)).toBeUndefined();
  });
});

it("rejects a foreign turn and child cancellation without changing the parent rule", async () => {
  const f = input(),
    root = new AbortController(),
    child = new AbortController();
  await runWithStreamingContext(
    {
      messageId: "assistant-stream",
      modelAttemptTurnId: String(f.message.id),
      abortSignal: root.signal,
    },
    async () => {
      const issuer = beginStage1NotesRequestIssuer(f.runtime, f.message);
      if (!issuer) throw Error("Host issuer missing");
      const source = { current: "request" };
      commitNotesRequestRestriction(issuer, {
        classification: "mutation_requested",
        source,
        currentSource: () => source,
      });
      bindTaskExtractionContext(
        f.state,
        f.message,
        f.context,
        f.context,
        f.runtime,
        issuer,
      );
      const attempt = beginRequestOperationAttempt(f),
        carrier = getStreamingContext()?.actionConstraints;
      runWithStreamingContext(
        {
          messageId: "foreign",
          abortSignal: child.signal,
          actionConstraints: carrier,
        },
        () => {
          expect(
            checkBoundNotesOperation(f.state, f.message, "create", attempt),
          ).toMatchObject({
            allowed: false,
            code: "REQUEST_OPERATION_UNRESOLVED",
          });
        },
      );
      child.abort();
      runWithStreamingContext(
        { messageId: "assistant-stream", abortSignal: child.signal },
        () => {
          expect(
            checkBoundNotesOperation(f.state, f.message, "create", attempt),
          ).toMatchObject({
            allowed: false,
            code: "REQUEST_OPERATION_UNRESOLVED",
          });
        },
      );
    },
  );
});

it("cannot mint a foreign Memory issuer under another actual incoming turn", () => {
  const f = input(),
    controller = new AbortController();
  runWithStreamingContext(
    {
      messageId: "assistant-stream",
      modelAttemptTurnId: String(f.message.id),
      abortSignal: controller.signal,
    },
    () => {
      expect(
        beginStage1NotesRequestIssuer(f.runtime, {
          ...f.message,
          id: "foreign",
        } as Memory),
      ).toBeUndefined();
      expect(beginStage1NotesRequestIssuer(f.runtime, f.message)).toBeDefined();
    },
  );
});

it("does not infer the incoming user identity from an assistant stream ID", () => {
  const f = input(),
    controller = new AbortController();
  runWithStreamingContext(
    { messageId: String(f.message.id), abortSignal: controller.signal },
    () => {
      expect(
        beginStage1NotesRequestIssuer(f.runtime, f.message),
      ).toBeUndefined();
    },
  );
});

it("taints a contradictory same-source operation recommit without granting a mutation", async () => {
  const f = input(),
    root = new AbortController();
  await runWithStreamingContext(
    {
      messageId: String(f.message.id),
      modelAttemptTurnId: String(f.message.id),
      abortSignal: root.signal,
    },
    async () => {
      const issuer = beginStage1NotesRequestIssuer(f.runtime, f.message);
      if (!issuer) throw new Error("Actual host issuer missing");
      const source = { actualClassifierInput: "current request" };
      expect(
        commitNotesRequestRestriction(issuer, {
          classification: "mutation_requested",
          source,
          currentSource: () => source,
          interpretation: { status: "explicit", operations: ["create"] },
        }),
      ).toBe(true);
      bindTaskExtractionContext(
        f.state,
        f.message,
        f.context,
        f.context,
        f.runtime,
        issuer,
      );
      expect(
        commitNotesRequestRestriction(issuer, {
          classification: "mutation_requested",
          source,
          currentSource: () => source,
          interpretation: { status: "explicit", operations: ["delete"] },
        }),
      ).toBe(false);
      expect(
        checkBoundNotesOperation(
          f.state,
          f.message,
          "create",
          beginRequestOperationAttempt(f),
        ),
      ).toMatchObject({
        allowed: false,
        addsAuthority: false,
        code: "REQUEST_OPERATION_UNRESOLVED",
      });
      root.abort();
    },
  );
});

it("fails closed on a classification/operation contradiction at the host commitment", async () => {
  const f = input(),
    root = new AbortController();
  await runWithStreamingContext(
    {
      messageId: String(f.message.id),
      modelAttemptTurnId: String(f.message.id),
      abortSignal: root.signal,
    },
    async () => {
      const issuer = beginStage1NotesRequestIssuer(f.runtime, f.message);
      if (!issuer) throw new Error("Actual host issuer missing");
      const source = { actualClassifierInput: "current request" };
      commitNotesRequestRestriction(issuer, {
        classification: "read_only",
        source,
        currentSource: () => source,
        interpretation: { status: "explicit", operations: ["create"] },
      });
      bindTaskExtractionContext(
        f.state,
        f.message,
        f.context,
        f.context,
        f.runtime,
        issuer,
      );
      expect(
        checkBoundNotesOperation(
          f.state,
          f.message,
          "create",
          beginRequestOperationAttempt(f),
        ),
      ).toMatchObject({
        allowed: false,
        addsAuthority: false,
        code: "REQUEST_OPERATION_UNRESOLVED",
      });
      expect(checkBoundNotesOperation(f.state, f.message, "get")).toEqual({
        allowed: true,
        addsAuthority: false,
      });
      root.abort();
    },
  );
});

it("canonicalizes a same-source operation set before recommit comparison", async () => {
  const f = input(),
    root = new AbortController();
  await runWithStreamingContext(
    {
      messageId: String(f.message.id),
      modelAttemptTurnId: String(f.message.id),
      abortSignal: root.signal,
    },
    async () => {
      const issuer = beginStage1NotesRequestIssuer(f.runtime, f.message);
      if (!issuer) throw new Error("Actual host issuer missing");
      const source = { actualClassifierInput: "current request" };
      expect(
        commitNotesRequestRestriction(issuer, {
          classification: "mutation_requested",
          source,
          currentSource: () => source,
          interpretation: {
            status: "explicit",
            operations: ["list", "create"],
          },
        }),
      ).toBe(true);
      expect(
        commitNotesRequestRestriction(issuer, {
          classification: "mutation_requested",
          source,
          currentSource: () => source,
          interpretation: {
            status: "explicit",
            operations: ["create", "list"],
          },
        }),
      ).toBe(true);
      root.abort();
    },
  );
});
