// @vitest-environment jsdom
//
// `useChatState` prepend coverage for the chat transcript's upward infinite
// scroll. The regression case is a full retained thread plus an older page:
// overflow must trim the newest tail, not discard the just-prepended page.

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

describe("useChatState prependConversationMessages", () => {
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
    expect(ids(result.current.conversationMessagesRef.current)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("dedupes by id so overlapping pages do not double-render turns", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([msg("b", 20), msg("c", 30)]);
    });

    act(() => {
      result.current.prependConversationMessages([msg("a", 10), msg("b", 20)]);
    });

    expect(ids(result.current.state.conversationMessages)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is a no-op when every prepended id is already present", () => {
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

  it("keeps a prepended older page when the retained 500-message thread is full", () => {
    const { result } = renderHook(() => useChatState());
    const cap = CONVERSATION_MAX_RETAINED_MESSAGES;
    const newest = Array.from({ length: cap }, (_, i) =>
      msg(`new-${i}`, 1_000_000 + i),
    );
    act(() => {
      result.current.setConversationMessages(newest);
    });

    const older = Array.from({ length: 25 }, (_, i) => msg(`old-${i}`, i));
    act(() => {
      result.current.prependConversationMessages(older);
    });

    const kept = result.current.state.conversationMessages;
    expect(kept).toHaveLength(cap);
    expect(kept[0].id).toBe("old-0");
    expect(kept[24].id).toBe("old-24");
    expect(kept[25].id).toBe("new-0");
    expect(kept.some((m) => m.id === `new-${cap - 1}`)).toBe(false);
    expect(result.current.conversationMessagesRef.current).toEqual(kept);
  });
});
