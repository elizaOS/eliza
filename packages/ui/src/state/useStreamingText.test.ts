/**
 * Behavioral coverage for applyStreamingTextModification — the single map pass
 * every in-flight chat-stream mutation flows through (used by useChatSend and
 * useChatCallbacks). Exercises the real module through a capturing setState
 * updater, which is the exact `Dispatch<SetStateAction<T>>` contract callers
 * hand it; no mocks, no React rendering. Pins the no-re-render contract
 * (referentially-equal `prev` returned on no-ops), per-mode patches,
 * provisional stamping/clearing, terminal-reconciliation field deletion, and
 * the id-swap duplicate-bubble fold.
 */
import { describe, expect, it } from "vitest";
import type { ChatTerminalFailure, ConversationMessage } from "../api";
import type {
  StreamingTextModification,
  StreamingTextSetter,
} from "./useStreamingText";
import { applyStreamingTextModification } from "./useStreamingText";

/** Defaults below pin every required field; overrides may only narrow optionals. */
type MessageOverrides = { id: string } & Partial<
  Omit<ConversationMessage, "id">
>;

function msg({ id, ...overrides }: MessageOverrides): ConversationMessage {
  return {
    id,
    role: "assistant",
    text: "",
    timestamp: 1_735_689_600_000,
    ...overrides,
  };
}

function applyTo(
  messages: ConversationMessage[],
  mod: StreamingTextModification,
): ConversationMessage[] {
  let latest = messages;
  const setMessages: StreamingTextSetter = (action) => {
    latest = typeof action === "function" ? action(messages) : action;
  };
  applyStreamingTextModification(setMessages, mod);
  return latest;
}

describe("applyStreamingTextModification", () => {
  describe("append mode", () => {
    it("appends a delta token to empty text", () => {
      const target = msg({ id: "temp-1" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "append",
        token: "Hel",
      });
      expect(next[0]?.text).toBe("Hel");
      expect(next[0]).not.toBe(target);
    });

    it("concatenates a follow-up delta onto accumulated text", () => {
      const target = msg({ id: "temp-1", text: "Hello" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "append",
        token: ", world",
      });
      expect(next[0]?.text).toBe("Hello, world");
    });

    it("preserves repeated single-character deltas like 'l' + 'l'", () => {
      const target = msg({ id: "temp-1", text: "l" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "append",
        token: "l",
      });
      expect(next[0]?.text).toBe("ll");
    });

    it("returns the same array reference when the token adds nothing (empty token)", () => {
      const target = msg({ id: "temp-1", text: "Hello" });
      const prev = [target];
      const next = applyTo(prev, {
        messageId: "temp-1",
        mode: "append",
        token: "",
      });
      expect(next).toBe(prev);
      expect(next[0]).toBe(target);
    });

    it("returns the same array reference when the token is a regressive snapshot already contained in the text", () => {
      const target = msg({ id: "temp-1", text: "Hello world" });
      const prev = [target];
      const next = applyTo(prev, {
        messageId: "temp-1",
        mode: "append",
        token: "Hello",
      });
      expect(next).toBe(prev);
    });

    it("stamps provisional on action-callback frames so voice output holds them", () => {
      const target = msg({ id: "temp-1" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "append",
        token: "On it",
        provisional: true,
      });
      expect(next[0]?.provisional).toBe(true);
      expect(next[0]?.text).toBe("On it");
    });

    it("clears a stale provisional marker on a non-provisional frame even when the text is unchanged", () => {
      const target = msg({ id: "temp-1", text: "Hi", provisional: true });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "append",
        token: "",
      });
      expect(next[0]).not.toBe(target);
      expect(next[0]?.provisional).toBeUndefined();
      expect(next[0]?.text).toBe("Hi");
    });
  });

  describe("replace mode", () => {
    it("replaces the accumulated text with the snapshot wholesale", () => {
      const target = msg({ id: "temp-1", text: "partial wor" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "replace",
        fullText: "partial work",
      });
      expect(next[0]?.text).toBe("partial work");
    });

    it("returns the same array reference when the snapshot matches the text", () => {
      const target = msg({ id: "temp-1", text: "snapshot" });
      const prev = [target];
      const next = applyTo(prev, {
        messageId: "temp-1",
        mode: "replace",
        fullText: "snapshot",
      });
      expect(next).toBe(prev);
    });

    it("stamps provisional when the replacement snapshot is action-callback text", () => {
      const target = msg({ id: "temp-1", text: "old" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "replace",
        fullText: "callback ack",
        provisional: true,
      });
      expect(next[0]?.provisional).toBe(true);
      expect(next[0]?.text).toBe("callback ack");
    });
  });

  describe("complete mode", () => {
    it("applies final text and every optional terminal field, rebinding the persisted id", () => {
      const target = msg({ id: "temp-resp-1", text: "streaming…" });
      const terminalFailure = {
        kind: "provider_issue",
        message: "generation failed",
        transient: false,
      } as const;
      const accountConnect = { providers: [], reason: "add a provider" };
      const next = applyTo([target], {
        messageId: "temp-resp-1",
        mode: "complete",
        fullText: "final answer",
        failureKind: "provider_issue",
        terminalFailure,
        accountConnect,
        reasoning: "thought hard",
        assistantEphemeral: true,
        persistedMessageId: "persisted-9",
      });
      const patched = next[0];
      expect(patched?.id).toBe("persisted-9");
      expect(patched?.text).toBe("final answer");
      expect(patched?.failureKind).toBe("provider_issue");
      expect(patched?.terminalFailure).toEqual(terminalFailure);
      expect(patched?.accountConnect).toBe(accountConnect);
      expect(patched?.reasoning).toBe("thought hard");
      expect(patched?.assistantEphemeral).toBe(true);
      expect(patched?.provisional).toBeUndefined();
    });

    it("clears stale failure metadata the final reconciled turn does not carry", () => {
      const target = msg({
        id: "temp-1",
        text: "fallback text",
        failureKind: "rate_limited",
        reasoning: "kept thought",
      });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "complete",
        fullText: "fallback text",
      });
      const patched = next[0];
      expect(patched?.failureKind).toBeUndefined();
      expect(patched?.reasoning).toBe("kept thought");
    });

    it("is a no-op returning the same reference when the completion changes nothing", () => {
      const target = msg({ id: "m-1", text: "done" });
      const prev = [target];
      const next = applyTo(prev, {
        messageId: "m-1",
        mode: "complete",
        fullText: "done",
        persistedMessageId: "m-1",
      });
      expect(next).toBe(prev);
      expect(next[0]).toBe(target);
    });

    it("folds away a duplicate WS echo bubble carrying the persisted id, keeping the streamed bubble in place", () => {
      const userTurn = msg({ id: "u1", role: "user", text: "hi" });
      const streamed = msg({
        id: "temp-resp-1",
        text: "streamed tail",
        timestamp: 2,
      });
      const echo = msg({
        id: "persisted-9",
        text: "",
        timestamp: 3,
      });
      const prev = [userTurn, streamed, echo];
      const next = applyTo(prev, {
        messageId: "temp-resp-1",
        mode: "complete",
        fullText: "final",
        persistedMessageId: "persisted-9",
      });
      expect(next).toHaveLength(2);
      expect(next.map((message) => message.id)).toEqual(["u1", "persisted-9"]);
      expect(next[1]?.text).toBe("final");
      expect(next).not.toBe(prev);
    });
  });

  describe("rekey mode", () => {
    it("rebinds the optimistic stream id to the durable persisted id", () => {
      const target = msg({ id: "temp-1", text: "kept" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "rekey",
        persistedMessageId: "persisted-42",
      });
      expect(next[0]?.id).toBe("persisted-42");
      expect(next[0]?.text).toBe("kept");
      expect(next[0]).not.toBe(target);
    });

    it("is a no-op returning the same reference when the id already matches", () => {
      const target = msg({ id: "persisted-42" });
      const prev = [target];
      const next = applyTo(prev, {
        messageId: "persisted-42",
        mode: "rekey",
        persistedMessageId: "persisted-42",
      });
      expect(next).toBe(prev);
    });

    it("folds a duplicate echo bubble during a rekey id-swap as well", () => {
      const streamed = msg({ id: "temp-1", text: "streamed" });
      const echo = msg({ id: "persisted-7", text: "" });
      const prev = [streamed, echo];
      const next = applyTo(prev, {
        messageId: "temp-1",
        mode: "rekey",
        persistedMessageId: "persisted-7",
      });
      expect(next).toHaveLength(1);
      expect(next[0]?.text).toBe("streamed");
      expect(next[0]?.id).toBe("persisted-7");
    });
  });

  describe("tool mode", () => {
    it("projects a call frame into a running tool row when the turn has no rows yet", () => {
      const target = msg({ id: "temp-1" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "tool",
        event: {
          phase: "call",
          callId: "call-1",
          toolName: "WEB_SEARCH",
          args: { query: "elizaOS" },
        },
      });
      expect(next[0]?.toolEvents).toEqual([
        {
          id: "call-1",
          callId: "call-1",
          toolName: "WEB_SEARCH",
          type: "tool_call",
          status: "running",
          args: { query: "elizaOS" },
        },
      ]);
    });

    it("flips the same row to completed on the result frame while preserving the call's args", () => {
      const target = msg({
        id: "temp-1",
        toolEvents: [
          {
            id: "call-1",
            callId: "call-1",
            toolName: "WEB_SEARCH",
            type: "tool_call",
            status: "running",
            args: { query: "elizaOS" },
          },
        ],
      });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "tool",
        event: {
          phase: "result",
          callId: "call-1",
          toolName: "WEB_SEARCH",
          result: "found it",
        },
      });
      expect(next[0]?.toolEvents).toHaveLength(1);
      const row = next[0]?.toolEvents?.[0];
      expect(row?.type).toBe("tool_result");
      expect(row?.status).toBe("completed");
      expect(row?.result).toBe("found it");
      expect(row?.args).toEqual({ query: "elizaOS" });
    });
  });

  describe("fail mode", () => {
    it("stamps the failure kind and terminal failure details without touching the text", () => {
      const target = msg({ id: "temp-1", text: "partial" });
      const terminalFailure: ChatTerminalFailure = {
        kind: "no_provider",
        message: "no provider configured",
        transient: true,
      };
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "fail",
        failureKind: "no_provider",
        terminalFailure,
      });
      expect(next[0]?.failureKind).toBe("no_provider");
      expect(next[0]?.terminalFailure).toEqual(terminalFailure);
      expect(next[0]?.text).toBe("partial");
    });

    it("is a no-op returning the same reference when the failure state is already stamped", () => {
      const terminalFailure: ChatTerminalFailure = {
        kind: "no_provider",
        message: "no provider configured",
        transient: true,
      };
      const target = msg({
        id: "temp-1",
        failureKind: "no_provider",
        terminalFailure,
      });
      const prev = [target];
      const next = applyTo(prev, {
        messageId: "temp-1",
        mode: "fail",
        failureKind: "no_provider",
        terminalFailure,
      });
      expect(next).toBe(prev);
    });
  });

  describe("interrupt mode", () => {
    it("marks the turn interrupted", () => {
      const target = msg({ id: "temp-1", text: "half sentence" });
      const next = applyTo([target], {
        messageId: "temp-1",
        mode: "interrupt",
      });
      expect(next[0]?.interrupted).toBe(true);
      expect(next[0]?.text).toBe("half sentence");
    });

    it("is a no-op returning the same reference when already interrupted", () => {
      const target = msg({ id: "temp-1", interrupted: true });
      const prev = [target];
      const next = applyTo(prev, { messageId: "temp-1", mode: "interrupt" });
      expect(next).toBe(prev);
    });
  });

  describe("drop mode", () => {
    it("removes the matching message and preserves the order of the rest", () => {
      const first = msg({ id: "keep-1" });
      const doomed = msg({ id: "temp-drop", timestamp: 2 });
      const last = msg({ id: "keep-2", timestamp: 3 });
      const next = applyTo([first, doomed, last], {
        messageId: "temp-drop",
        mode: "drop",
      });
      expect(next.map((message) => message.id)).toEqual(["keep-1", "keep-2"]);
      expect(next).not.toContain(doomed);
    });

    it("returns the same array reference when nothing matched, including on an empty list", () => {
      const keep = msg({ id: "keep-1" });
      const prev = [keep];
      const next = applyTo(prev, { messageId: "absent", mode: "drop" });
      expect(next).toBe(prev);

      const empty: ConversationMessage[] = [];
      expect(applyTo(empty, { messageId: "absent", mode: "drop" })).toBe(empty);
    });
  });

  describe("no-op identity across the reducer", () => {
    it("returns the same reference when no message carries the target id", () => {
      const other = msg({ id: "other-1", text: "untouched" });
      const prev = [other];
      const next = applyTo(prev, {
        messageId: "missing-id",
        mode: "append",
        token: "x",
      });
      expect(next).toBe(prev);
      expect(next[0]).toBe(other);
    });
  });
});
