// @vitest-environment jsdom
//
// `useChatState` unread-badge clearing: opening a conversation must clear its
// unread badge. `unreadConversations` is a reducer field whose functional
// `setUnreadConversations` wrapper can only re-ADD ids, so clearing rides the
// SET_ACTIVE_CONVERSATION_ID transition (the single dispatch that always fires
// on open) rather than a remove-updater. Real hook under jsdom + real
// localStorage.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useChatState } from "./useChatState";

beforeEach(() => {
  window.localStorage.clear();
});

describe("useChatState — unread badge clears on open (#FIX3)", () => {
  it("clears the opened conversation's badge and leaves others intact", () => {
    const { result } = renderHook(() => useChatState());

    act(() => {
      result.current.addUnread("conv-a");
      result.current.addUnread("conv-b");
    });
    expect(result.current.state.unreadConversations.has("conv-a")).toBe(true);
    expect(result.current.state.unreadConversations.has("conv-b")).toBe(true);

    // Opening conv-a marks it read.
    act(() => {
      result.current.setActiveConversationId("conv-a");
    });
    expect(result.current.state.activeConversationId).toBe("conv-a");
    expect(result.current.state.unreadConversations.has("conv-a")).toBe(false);
    // A conversation you did NOT open keeps its badge.
    expect(result.current.state.unreadConversations.has("conv-b")).toBe(true);
  });

  it("is a no-op (same set reference) when the opened conversation has no badge", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.addUnread("conv-b");
    });
    const before = result.current.state.unreadConversations;

    act(() => {
      result.current.setActiveConversationId("conv-a"); // conv-a is not unread
    });

    // Nothing removed → the set reference is preserved (no needless churn).
    expect(result.current.state.unreadConversations).toBe(before);
    expect(result.current.state.activeConversationId).toBe("conv-a");
  });

  it("opening a null (no) conversation never throws and preserves the set", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.addUnread("conv-b");
    });
    const before = result.current.state.unreadConversations;

    act(() => {
      result.current.setActiveConversationId(null);
    });

    expect(result.current.state.unreadConversations).toBe(before);
    expect(result.current.state.activeConversationId).toBeNull();
  });
});
