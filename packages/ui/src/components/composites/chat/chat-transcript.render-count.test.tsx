// @vitest-environment jsdom

// Regression lock for elizaOS/eliza issue #9141 (chat-transcript UI perf).
//
// Streaming a token into the LAST message must re-render ONLY that last
// `ChatMessage` row, never the whole list. `ChatMessage` is wrapped in
// `memo(..., arePropsEqual)` and `ChatTranscript` keys rows by stable message
// id, so a transcript update that touches one row's `message` reference leaves
// every other memoized row untouched. This test counts per-row renders and
// fails if that memoization regresses (e.g. an inline prop rebuilt every render
// defeats `arePropsEqual`, or row keys stop being stable).
//
// HOW RENDERS ARE COUNTED: `ChatTranscript` forwards `renderMessageContent`
// down to each `ChatMessage`, which invokes it exactly once per render of the
// row body (`chat-message.tsx`: `renderContent?.(message)`). It is a real
// production prop — not a test-only hook — so tallying invocations per message
// id is a faithful per-`ChatMessage` render counter.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatTranscript } from "./chat-transcript";
import type { ChatMessageData } from "./chat-types";

afterEach(() => {
  cleanup();
});

const MESSAGE_COUNT = 10;

function makeTranscript(streamedSuffix = ""): ChatMessageData[] {
  const messages: ChatMessageData[] = [];
  for (let index = 0; index < MESSAGE_COUNT - 1; index += 1) {
    messages.push({
      id: `msg-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index}`,
    });
  }
  // The last message is the streaming assistant turn whose text grows token by
  // token. Only its text changes between the two renders below.
  messages.push({
    id: `msg-${MESSAGE_COUNT - 1}`,
    role: "assistant",
    text: `streaming reply${streamedSuffix}`,
  });
  return messages;
}

/** Per-message-id render tally driven by the real `renderMessageContent` prop. */
function makeRenderCounter() {
  const counts = new Map<string, number>();
  const spy = vi.fn((message: ChatMessageData) => {
    counts.set(message.id, (counts.get(message.id) ?? 0) + 1);
    return <span data-testid={`content-${message.id}`}>{message.text}</span>;
  });
  return { counts, spy };
}

describe("ChatTranscript render count (#9141)", () => {
  it("re-renders only the last message when a streamed token is appended", () => {
    const { counts, spy } = makeRenderCounter();

    const rendered = render(
      <ChatTranscript messages={makeTranscript()} renderMessageContent={spy} />,
    );

    // Initial mount: every row renders exactly once.
    expect(spy).toHaveBeenCalledTimes(MESSAGE_COUNT);
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      expect(counts.get(`msg-${index}`)).toBe(1);
    }

    const countsAfterMount = new Map(counts);

    // Simulate one streamed token landing on the last message. New array +
    // fresh object references for every row (exactly what the chat container
    // produces on each stream tick); only the last row's text actually changed.
    rendered.rerender(
      <ChatTranscript
        messages={makeTranscript(" more")}
        renderMessageContent={spy}
      />,
    );

    const lastId = `msg-${MESSAGE_COUNT - 1}`;

    // Only the last row re-rendered; every historical row stayed at its mount count.
    for (let index = 0; index < MESSAGE_COUNT - 1; index += 1) {
      const id = `msg-${index}`;
      expect(counts.get(id)).toBe(countsAfterMount.get(id));
    }
    expect(counts.get(lastId)).toBe((countsAfterMount.get(lastId) ?? 0) + 1);

    // Total invocations: MESSAGE_COUNT mounts + exactly one streamed re-render.
    expect(spy).toHaveBeenCalledTimes(MESSAGE_COUNT + 1);
    expect(spy.mock.calls.at(-1)?.[0].id).toBe(lastId);
    expect(spy.mock.calls.at(-1)?.[0].text).toBe("streaming reply more");
  });

  it("does not re-render any row when the messages array is rebuilt but no row changed", () => {
    const { counts, spy } = makeRenderCounter();

    const rendered = render(
      <ChatTranscript messages={makeTranscript()} renderMessageContent={spy} />,
    );
    expect(spy).toHaveBeenCalledTimes(MESSAGE_COUNT);

    // Identical content, brand-new array + object references (a no-op parent
    // re-render). `arePropsEqual` must short-circuit every row.
    rendered.rerender(
      <ChatTranscript messages={makeTranscript()} renderMessageContent={spy} />,
    );

    expect(spy).toHaveBeenCalledTimes(MESSAGE_COUNT);
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      expect(counts.get(`msg-${index}`)).toBe(1);
    }
  });
});
