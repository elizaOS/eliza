// @vitest-environment jsdom
/**
 * Guards ChatTranscript's row memoization: unchanged historical rows must not
 * re-render while a streamed update mutates the tail. RTL in jsdom, no live
 * model — asserts render behavior, not model output.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatTranscript } from "./chat-transcript";
import type { ChatMessageData } from "./chat-types";

afterEach(() => {
  cleanup();
});

function makeMessage(
  id: string,
  role: ChatMessageData["role"],
  text: string,
): ChatMessageData {
  return { id, role, text };
}

describe("ChatTranscript memoization", () => {
  it("does not re-render unchanged historical rows during streamed updates", () => {
    const first = makeMessage("msg-1", "user", "hello");
    const second = makeMessage("msg-2", "assistant", "thinking");
    const renderMessageContent = vi.fn((message: ChatMessageData) => (
      <span data-testid={`content-${message.id}`}>{message.text}</span>
    ));

    const rendered = render(
      <ChatTranscript
        messages={[first, second]}
        renderMessageContent={renderMessageContent}
      />,
    );

    expect(renderMessageContent).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("content-msg-1").textContent).toBe("hello");
    expect(screen.getByTestId("content-msg-2").textContent).toBe("thinking");

    rendered.rerender(
      <ChatTranscript
        messages={[{ ...first }, { ...second, text: "thinking harder" }]}
        renderMessageContent={renderMessageContent}
      />,
    );

    expect(renderMessageContent).toHaveBeenCalledTimes(3);
    expect(renderMessageContent.mock.calls[2]?.[0].id).toBe("msg-2");
    expect(screen.getByTestId("content-msg-1").textContent).toBe("hello");
    expect(screen.getByTestId("content-msg-2").textContent).toBe(
      "thinking harder",
    );
  });
});
