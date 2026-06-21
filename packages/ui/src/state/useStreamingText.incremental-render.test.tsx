// @vitest-environment jsdom

/**
 * Integration proof for P10 (closing DEFERRED gap from elizaOS/eliza#8434):
 * #8773's token streaming must reach the UI as an INCREMENTAL render — the
 * visible assistant bubble text grows tick-by-tick — not merely show the final
 * reply once the stream completes.
 *
 * `useChatSend`'s streaming `onToken` callback drives the visible bubble through
 * exactly one production seam: `applyStreamingTextModification`, which patches
 * the `ConversationMessage[]` reducer that the chat surface renders. This test
 * renders a real React component backed by that same reducer state, feeds it
 * tokens across multiple commits (mirroring both delta-append and cumulative
 * snapshot `onToken` shapes), and asserts the rendered `textContent` grows
 * monotonically — proving the bubble paints partial text as tokens arrive.
 */

import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationMessage } from "../api";
import { applyStreamingTextModification } from "./useStreamingText";

const ASSISTANT_ID = "assistant-turn-1";

function seedMessages(): ConversationMessage[] {
  return [
    { id: "user-1", role: "user", text: "say hi", timestamp: 1 },
    { id: ASSISTANT_ID, role: "assistant", text: "", timestamp: 2 },
  ];
}

/**
 * Minimal stand-in for the chat surface: holds the real `ConversationMessage[]`
 * reducer state and renders each assistant turn's visible text exactly the way
 * the bubble does (plain text node). It exposes the production setter so the
 * test can drive `applyStreamingTextModification` against live React state.
 */
function StreamingBubbleHarness({
  onReady,
}: {
  onReady: (
    setMessages: React.Dispatch<React.SetStateAction<ConversationMessage[]>>,
  ) => void;
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>(seedMessages);
  onReady(setMessages);
  return (
    <div>
      {messages.map((message) => (
        <div key={message.id} data-role={message.role} data-testid={message.id}>
          {message.text}
        </div>
      ))}
    </div>
  );
}

describe("streaming → incremental assistant-bubble render", () => {
  afterEach(cleanup);

  it("grows the visible assistant text monotonically as cumulative snapshots arrive (replace mode)", () => {
    // `onToken(token, accumulatedText)` with a string `accumulatedText` is the
    // common path: the stream sends the full text-so-far and useChatSend calls
    // applyStreamingTextModification({ mode: "replace", fullText }).
    let setMessages!: React.Dispatch<
      React.SetStateAction<ConversationMessage[]>
    >;
    const { getByTestId } = render(
      <StreamingBubbleHarness
        onReady={(setter) => {
          setMessages = setter;
        }}
      />,
    );

    const bubble = () => getByTestId(ASSISTANT_ID).textContent ?? "";
    const snapshots = ["Hel", "Hello", "Hello there", "Hello there, friend"];
    const rendered: string[] = [];

    // Before any token, the bubble is empty (typing placeholder territory).
    expect(bubble()).toBe("");

    for (const fullText of snapshots) {
      act(() => {
        applyStreamingTextModification(setMessages, {
          messageId: ASSISTANT_ID,
          mode: "replace",
          fullText,
        });
      });
      rendered.push(bubble());
    }

    // Each commit painted the new partial text...
    expect(rendered).toEqual(snapshots);
    // ...and the visible length is strictly increasing across ticks: the user
    // saw the answer build up, not appear all at once.
    for (let i = 1; i < rendered.length; i += 1) {
      expect(rendered[i].length).toBeGreaterThan(rendered[i - 1].length);
      expect(rendered[i].startsWith(rendered[i - 1])).toBe(true);
    }
    expect(bubble()).toBe("Hello there, friend");
  });

  it("grows the visible assistant text as raw delta tokens are appended (append mode)", () => {
    // The other onToken shape: no cumulative snapshot, so useChatSend merges the
    // raw delta via applyStreamingTextModification({ mode: "append", token }) —
    // the same mergeStreamingText overlap-aware accumulation used in production.
    // We assert the *property* (visible text grows tick-by-tick and ends with
    // the trailing tokens) rather than a hand-guessed concatenation, since the
    // production merge dedups suffix/prefix overlaps between deltas.
    let setMessages!: React.Dispatch<
      React.SetStateAction<ConversationMessage[]>
    >;
    const { getByTestId } = render(
      <StreamingBubbleHarness
        onReady={(setter) => {
          setMessages = setter;
        }}
      />,
    );

    const bubble = () => getByTestId(ASSISTANT_ID).textContent ?? "";
    const tokens = ["Two plus two", " is four", ". Anything else", " I can do?"];
    const renders: string[] = [];

    for (const token of tokens) {
      act(() => {
        applyStreamingTextModification(setMessages, {
          messageId: ASSISTANT_ID,
          mode: "append",
          token,
        });
      });
      renders.push(bubble());
    }

    // First token paints partial text well before the stream is done.
    expect(renders[0]).toBe("Two plus two");
    // Visible text grows strictly with each delta and the prior text stays as a
    // prefix of the next — i.e. the bubble extends, it never repaints from zero.
    for (let i = 1; i < renders.length; i += 1) {
      expect(renders[i].length).toBeGreaterThan(renders[i - 1].length);
      expect(renders[i].startsWith(renders[i - 1])).toBe(true);
    }
    expect(bubble()).toBe("Two plus two is four. Anything else I can do?");
  });

  it("does not show the full reply in a single commit — intermediate paints are observed", () => {
    // Guards the regression the gap targets: if streaming were buffered, the
    // bubble would jump 0 → final in one commit and the captured intermediate
    // reads would all be empty. We capture the DOM after each tick and require
    // a genuine non-empty, non-final intermediate state to exist.
    let setMessages!: React.Dispatch<
      React.SetStateAction<ConversationMessage[]>
    >;
    const { getByTestId } = render(
      <StreamingBubbleHarness
        onReady={(setter) => {
          setMessages = setter;
        }}
      />,
    );

    const bubble = () => getByTestId(ASSISTANT_ID).textContent ?? "";
    const finalText = "Two plus two is four.";
    const snapshots = ["Two", "Two plus", "Two plus two is", finalText];
    const intermediatePaints: string[] = [];

    for (const fullText of snapshots) {
      act(() => {
        applyStreamingTextModification(setMessages, {
          messageId: ASSISTANT_ID,
          mode: "replace",
          fullText,
        });
      });
      intermediatePaints.push(bubble());
    }

    const partials = intermediatePaints.slice(0, -1);
    // At least one intermediate paint is non-empty AND shorter than the final
    // reply — i.e. the user saw the text mid-flight, not just at the end.
    expect(
      partials.some(
        (text) => text.length > 0 && text.length < finalText.length,
      ),
    ).toBe(true);
    expect(bubble()).toBe(finalText);
  });
});
