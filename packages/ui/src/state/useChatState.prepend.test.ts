// @vitest-environment jsdom
//
// `useChatState` PREPEND_MESSAGES / prependConversationMessages: the infinite
// upward scroll (#13532) merges an older page in FRONT of the current thread,
// deduped by id and capped at CONVERSATION_MAX_RETAINED_MESSAGES. The
// synchronous conversationMessagesRef must stay exactly in step with the
// dispatched state so callbacks reading the ref right after a prepend see the
// merged, capped thread. Real hook under jsdom.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import {
  CONVERSATION_MAX_RETAINED_MESSAGES,
  useChatState,
} from "./useChatState";

beforeEach(() => {
  window.localStorage.clear();
});

function msg(id: string, timestamp: number): ConversationMessage {
  return { id, role: "user", text: `m-${id}`, timestamp };
}

function ids(messages: ConversationMessage[]): string[] {
  return messages.map((m) => m.id);
}

describe("useChatState — prependConversationMessages (#13532)", () => {
  it("prepends an older page in front of the current thread", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([msg("c", 30), msg("d", 40)]);
    });

    act(() => {
      result.current.prependConversationMessages([msg("a", 10), msg("b", 20)]);
    });

    expect(ids(result.current.state.conversationMessages)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    // The synchronous ref matches the dispatched state exactly.
    expect(ids(result.current.conversationMessagesRef.current)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("dedupes by id so an overlapping page never double-renders a turn", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([msg("b", 20), msg("c", 30)]);
    });

    // Page overlaps on "b" — only the genuinely older "a" is added.
    act(() => {
      result.current.prependConversationMessages([msg("a", 10), msg("b", 20)]);
    });

    expect(ids(result.current.state.conversationMessages)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is a no-op (same reference) when every prepended id is already present", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([msg("a", 10), msg("b", 20)]);
    });
    const before = result.current.state.conversationMessages;

    act(() => {
      result.current.prependConversationMessages([msg("a", 10)]);
    });

    expect(result.current.state.conversationMessages).toBe(before);
  });

  it("is a no-op for an empty page", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([msg("a", 10)]);
    });
    const before = result.current.state.conversationMessages;

    act(() => {
      result.current.prependConversationMessages([]);
    });

    expect(result.current.state.conversationMessages).toBe(before);
  });

  it("caps the retained count from the FRONT over many pages (newest turns survive)", () => {
    const { result } = renderHook(() => useChatState());
    const cap = CONVERSATION_MAX_RETAINED_MESSAGES;

    // Seed the newest `cap` turns: ids "new-0".."new-(cap-1)", timestamps above
    // any older page.
    const newest = Array.from({ length: cap }, (_, i) =>
      msg(`new-${i}`, 1_000_000 + i),
    );
    act(() => {
      result.current.setConversationMessages(newest);
    });

    // Prepend a full page of older turns — total would exceed the cap.
    const older = Array.from({ length: 100 }, (_, i) => msg(`old-${i}`, i));
    act(() => {
      result.current.prependConversationMessages(older);
    });

    const kept = result.current.state.conversationMessages;
    // Capped to exactly the max.
    expect(kept).toHaveLength(cap);
    // The oldest prepended turns dropped off the FRONT; the newest turns (the
    // ones the reader is near) all survive.
    expect(kept[kept.length - 1].id).toBe(`new-${cap - 1}`);
    expect(kept.some((m) => m.id === `new-0`)).toBe(true);
    // Some of the oldest prepended page was trimmed away.
    expect(kept.some((m) => m.id === "old-0")).toBe(false);
    // The ref matches the capped state.
    expect(result.current.conversationMessagesRef.current).toHaveLength(cap);
  });
});
