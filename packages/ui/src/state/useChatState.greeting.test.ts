// @vitest-environment jsdom
//
// `useChatState.setConversationMessages` enforces the single-greeting-per-thread
// invariant at the one commit point every seed path routes through. Regression
// for the device-review duplicate-greeting defect: a create/fetch race across a
// cloud agent switch landed two greeting-sourced bubbles with identical text
// that the per-seed `appendGreetingOnce` guard could not catch once state reset
// between seeds. The setter now routes through `dedupeGreetings`, so no seed
// path — SET, append, or reseed — can commit two greetings.

import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import { useChatState } from "./useChatState";

beforeEach(() => {
  window.localStorage.clear();
});

function greeting(
  id: string,
  text = "Hey, I'm Agent. What can I help you with?",
): ConversationMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: 1,
    source: MESSAGE_SOURCE_AGENT_GREETING,
  };
}

function greetingSources(messages: ConversationMessage[]): number {
  return messages.filter(
    (m) => m.role === "assistant" && m.source === MESSAGE_SOURCE_AGENT_GREETING,
  ).length;
}

describe("useChatState single-greeting invariant", () => {
  it("collapses a SET that would commit two greeting bubbles to one", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      // A racing seed path commits a thread already carrying two greetings
      // (identical text — the exact device defect).
      result.current.setConversationMessages([greeting("g1"), greeting("g2")]);
    });
    expect(greetingSources(result.current.state.conversationMessages)).toBe(1);
    // Earliest greeting wins so the visible bubble never swaps.
    expect(result.current.state.conversationMessages[0].id).toBe("g1");
    expect(result.current.conversationMessagesRef.current[0].id).toBe("g1");
  });

  it("keeps the first greeting when a late functional append seeds a second", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([greeting("inline")]);
    });
    act(() => {
      // A late fetch appends a second greeting (different id, same source) —
      // the interleaving `appendGreetingOnce` misses after a state reset.
      result.current.setConversationMessages((prev) => [
        ...prev,
        greeting("late"),
      ]);
    });
    expect(greetingSources(result.current.state.conversationMessages)).toBe(1);
    expect(result.current.state.conversationMessages[0].id).toBe("inline");
  });

  it("is a no-op for a normal thread (preserves non-greeting order + tail)", () => {
    const { result } = renderHook(() => useChatState());
    const thread: ConversationMessage[] = [
      greeting("g1"),
      { id: "u1", role: "user", text: "hello", timestamp: 2 },
      { id: "a1", role: "assistant", text: "hi back", timestamp: 3 },
    ];
    act(() => {
      result.current.setConversationMessages(thread);
    });
    expect(result.current.state.conversationMessages.map((m) => m.id)).toEqual([
      "g1",
      "u1",
      "a1",
    ]);
  });
});
