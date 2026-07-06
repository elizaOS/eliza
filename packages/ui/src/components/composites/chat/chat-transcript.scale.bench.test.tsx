// @vitest-environment jsdom
//
// Transcript-scale render benchmark (perf/chat-render-benchmarks). Complements
// the fixed-size #9141 lock (chat-transcript.render-count.test.tsx) by proving
// the per-row memoization holds at a REALISTIC long-conversation scale: with
// 500 (and 1000) messages mounted, appending a message and streaming a token
// into the tail must re-render a BOUNDED number of rows — independent of how
// many historical rows are on screen. If a regression made an appended token
// re-render O(N) rows, this catches it where the 10-message lock cannot (10
// re-renders is cheap; 1000 is jank). It also records the wall cost of the
// append commit as an absolute smoke budget.
//
// Renders are counted the same way as #9141: the real `renderMessageContent`
// prop is a spy invoked exactly once per row-body render, so per-id tallies are
// a faithful per-`ChatMessage` render counter — not a test-only hook.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "./chat-transcript";
import type { ChatMessageData } from "./chat-types";

afterEach(cleanup);

function makeTranscript(count: number, streamedSuffix = ""): ChatMessageData[] {
  const messages: ChatMessageData[] = [];
  for (let i = 0; i < count; i += 1) {
    const isLast = i === count - 1;
    messages.push({
      id: `msg-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      // Only the last (streaming) row's text changes between renders.
      text: isLast ? `streaming reply${streamedSuffix}` : `message ${i}`,
    });
  }
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

describe("ChatTranscript scale render benchmark", () => {
  for (const size of [500, 1000]) {
    it(`streaming a token with ${size} messages re-renders only the tail row`, () => {
      const { counts, spy } = makeRenderCounter();
      const rendered = render(
        <ChatTranscript
          messages={makeTranscript(size)}
          renderMessageContent={spy}
        />,
      );

      // Mount: every row renders exactly once.
      expect(spy).toHaveBeenCalledTimes(size);
      const mountCounts = new Map(counts);

      // One streamed token lands on the tail. New array + fresh object
      // references for EVERY row (exactly what the chat container produces per
      // stream tick); only the last row's text actually changed.
      const start = performance.now();
      rendered.rerender(
        <ChatTranscript
          messages={makeTranscript(size, " more")}
          renderMessageContent={spy}
        />,
      );
      const streamCommitMs = performance.now() - start;

      // Bounded re-render: every historical row stayed at its mount count.
      let rerendered = 0;
      for (let i = 0; i < size; i += 1) {
        const id = `msg-${i}`;
        if ((counts.get(id) ?? 0) !== (mountCounts.get(id) ?? 0))
          rerendered += 1;
      }
      // Exactly one row (the streaming tail) re-rendered — independent of size.
      expect(rerendered).toBe(1);
      expect(counts.get(`msg-${size - 1}`)).toBe(
        (mountCounts.get(`msg-${size - 1}`) ?? 0) + 1,
      );
      expect(spy).toHaveBeenCalledTimes(size + 1);

      // Absolute smoke budget for the append commit — generous; the point of
      // the test is the bounded-row-count assertion above, this only catches a
      // pathological slowdown on the commit itself.
      expect(streamCommitMs).toBeLessThan(250);
    });

    it(`appending a message with ${size} existing messages mounts only the new row`, () => {
      const { counts, spy } = makeRenderCounter();
      const rendered = render(
        <ChatTranscript
          messages={makeTranscript(size)}
          renderMessageContent={spy}
        />,
      );
      expect(spy).toHaveBeenCalledTimes(size);
      const mountCounts = new Map(counts);

      // Append one brand-new message (a fresh assistant turn arriving).
      const grown = makeTranscript(size);
      grown.push({ id: `msg-new`, role: "assistant", text: "a new turn" });
      rendered.rerender(
        <ChatTranscript messages={grown} renderMessageContent={spy} />,
      );

      // No historical row re-rendered; only the new row mounted.
      let historicalRerenders = 0;
      for (let i = 0; i < size; i += 1) {
        const id = `msg-${i}`;
        if ((counts.get(id) ?? 0) !== (mountCounts.get(id) ?? 0))
          historicalRerenders += 1;
      }
      expect(historicalRerenders).toBe(0);
      expect(counts.get("msg-new")).toBe(1);
      expect(spy).toHaveBeenCalledTimes(size + 1);
    });
  }
});
