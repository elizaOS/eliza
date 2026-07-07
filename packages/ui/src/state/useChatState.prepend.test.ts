// @vitest-environment jsdom
//
// `useChatState` prepend coverage for the chat transcript's upward infinite
// scroll. The regression case is a long thread plus an older page: prepending
// must NEVER drop the newest tail (#13532) — dropping it stranded the true
// latest out of state (breaking jumpToLatest) and made the scroll-anchor
// restore yank the viewport downward once the thread crossed the old cap.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import { useChatState } from "./useChatState";

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

  it("retains the newest tail when a long thread pages older past the old 500 cap", () => {
    const { result } = renderHook(() => useChatState());
    const newestCount = 500;
    const newest = Array.from({ length: newestCount }, (_, i) =>
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
    // No trim: 25 older prepended in front, every newest turn preserved.
    expect(kept).toHaveLength(newestCount + 25);
    expect(kept[0].id).toBe("old-0");
    expect(kept[24].id).toBe("old-24");
    expect(kept[25].id).toBe("new-0");
    // The true latest — what jumpToLatest / bottom-follow must still reach —
    // survives the prepend instead of being sliced off the tail.
    expect(kept[kept.length - 1].id).toBe(`new-${newestCount - 1}`);
    expect(result.current.conversationMessagesRef.current).toEqual(kept);
  });
});

// ── Single-greeting invariant across pagination (duplicate-greeting defect) ──
// A poisoned thread's duplicated greeting pair sits at the very HEAD, so both
// rows arrive in the same load-older batch and would bypass the
// setConversationMessages dedupe seam entirely.
import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";

function greetingRow(id: string, timestamp: number): ConversationMessage {
  return {
    id,
    role: "assistant",
    text: "Hey, I'm Agent. What can I help you with?",
    timestamp,
    source: MESSAGE_SOURCE_AGENT_GREETING,
  };
}

describe("prependConversationMessages single-greeting invariant", () => {
  it("keeps ONE greeting when a batch carries a duplicated pair", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([msg("tail", 100)]);
    });
    act(() => {
      result.current.prependConversationMessages([
        greetingRow("g1", 1),
        greetingRow("g2", 2),
        msg("old", 50),
      ]);
    });
    const greetings = result.current.state.conversationMessages.filter(
      (m) => m.source === MESSAGE_SOURCE_AGENT_GREETING,
    );
    expect(greetings).toHaveLength(1);
    expect(greetings[0].id).toBe("g1");
    expect(ids(result.current.state.conversationMessages)).toEqual([
      "g1",
      "old",
      "tail",
    ]);
  });

  it("drops an older greeting when the window already carries one", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([
        greetingRow("kept", 10),
        msg("m1", 20),
      ]);
    });
    act(() => {
      result.current.prependConversationMessages([greetingRow("dupe", 1)]);
    });
    expect(ids(result.current.state.conversationMessages)).toEqual([
      "kept",
      "m1",
    ]);
  });

  it("passes a healthy single greeting through untouched", () => {
    const { result } = renderHook(() => useChatState());
    act(() => {
      result.current.setConversationMessages([msg("m1", 20)]);
    });
    act(() => {
      result.current.prependConversationMessages([greetingRow("g1", 1)]);
    });
    expect(ids(result.current.state.conversationMessages)).toEqual([
      "g1",
      "m1",
    ]);
  });
});
