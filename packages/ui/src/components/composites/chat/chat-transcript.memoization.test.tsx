// @vitest-environment jsdom
/**
 * Guards ChatTranscript's row memoization: unchanged historical rows must not
 * re-render while a streamed update mutates the tail. RTL in jsdom, no live
 * model — asserts render behavior, not model output.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NativeToolCallEvent } from "../../../api/client-types-cloud";
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

function makeToolEvent(callId: string): NativeToolCallEvent {
  return {
    id: `traj-${callId}`,
    type: "tool_call",
    timestamp: 1,
    callId,
    toolName: "search",
    status: "running",
  };
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

  it("re-renders a row when a streamed tool event lands (toolEvents identity change)", () => {
    // A mode:"tool" stream update rebuilds the message with a NEW toolEvents
    // array while text/id/every other compared field stays identical. The memo
    // must let that through — this is the row flipping a tool from running to
    // settled (#13535). Fails without the a.toolEvents === b.toolEvents compare.
    const user = makeMessage("msg-1", "user", "run the tool");
    const assistant: ChatMessageData = {
      ...makeMessage("msg-2", "assistant", "on it"),
      toolEvents: [makeToolEvent("call-1")],
    };
    const renderMessageContent = vi.fn((message: ChatMessageData) => (
      <span data-testid={`content-${message.id}`}>
        {message.toolEvents?.map((event) => event.status).join(",") ?? "none"}
      </span>
    ));

    const rendered = render(
      <ChatTranscript
        messages={[user, assistant]}
        renderMessageContent={renderMessageContent}
      />,
    );
    expect(renderMessageContent).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("content-msg-2").textContent).toBe("running");

    rendered.rerender(
      <ChatTranscript
        messages={[
          { ...user },
          {
            ...assistant,
            toolEvents: [{ ...makeToolEvent("call-1"), status: "completed" }],
          },
        ]}
        renderMessageContent={renderMessageContent}
      />,
    );

    // Only the tool row re-rendered, and it shows the settled status.
    expect(renderMessageContent).toHaveBeenCalledTimes(3);
    expect(renderMessageContent.mock.calls[2]?.[0].id).toBe("msg-2");
    expect(screen.getByTestId("content-msg-2").textContent).toBe("completed");
  });

  it("does NOT re-render a row whose toolEvents reference is unchanged", () => {
    // The transcript rebuilds message OBJECTS every parent render; a row whose
    // toolEvents array is the SAME reference (no tool change) must still be
    // memo-skipped, exactly like unchanged text.
    const toolEvents = [makeToolEvent("call-1")];
    const user = makeMessage("msg-1", "user", "run the tool");
    const assistant: ChatMessageData = {
      ...makeMessage("msg-2", "assistant", "on it"),
      toolEvents,
    };
    const renderMessageContent = vi.fn((message: ChatMessageData) => (
      <span data-testid={`content-${message.id}`}>{message.text}</span>
    ));

    const rendered = render(
      <ChatTranscript
        messages={[user, assistant]}
        renderMessageContent={renderMessageContent}
      />,
    );
    expect(renderMessageContent).toHaveBeenCalledTimes(2);

    rendered.rerender(
      <ChatTranscript
        messages={[{ ...user }, { ...assistant, toolEvents }]}
        renderMessageContent={renderMessageContent}
      />,
    );

    // Same compared fields + same toolEvents reference → no row re-rendered.
    expect(renderMessageContent).toHaveBeenCalledTimes(2);
  });
});
