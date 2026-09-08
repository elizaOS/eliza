/** Verifies that stopped assistant turns remain visibly distinct in both chat renderers. */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChatMessage } from "./chat-message";

afterEach(cleanup);

it.each([true, false])(
  "renders empty and partial interrupted replies, then clears the status for a completed reply (glass=%s)",
  (glass) => {
    const message = {
      id: "stopped",
      role: "assistant" as const,
      text: "",
      interrupted: true,
    };
    const { rerender } = render(
      <ChatMessage message={message} appearance={glass ? "glass" : "panel"} />,
    );
    expect(screen.getByText("Response interrupted").textContent).toContain(
      "Response interrupted",
    );
    rerender(
      <ChatMessage
        message={{ ...message, text: "The partial answer" }}
        appearance={glass ? "glass" : "panel"}
      />,
    );
    expect(screen.getByText("The partial answer")).toBeTruthy();
    expect(screen.getByText("Response interrupted")).toBeTruthy();
    rerender(
      <ChatMessage
        message={{
          ...message,
          text: "The complete answer",
          interrupted: false,
        }}
        appearance={glass ? "glass" : "panel"}
      />,
    );
    expect(screen.queryByText("Response interrupted")).toBeNull();
    expect(screen.getByText("The complete answer")).toBeTruthy();
  },
);
