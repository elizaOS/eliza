/** Verifies expected response interruption is presented as neutral status, never as an error. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatMessage } from "./chat-message";
import type { ChatMessageData } from "./chat-types";

const interruptedMessage: ChatMessageData = {
  id: "assistant-interrupted",
  role: "assistant",
  text: "Only the prefix the user actually saw remains.",
  interrupted: true,
};

afterEach(cleanup);

describe("ChatMessage interrupted status", () => {
  it.each(["glass", "panel"] as const)(
    "renders the %s status as a calm stopped state",
    (appearance) => {
      render(
        <ChatMessage appearance={appearance} message={interruptedMessage} />,
      );

      const status = screen.getByTestId("chat-message-interrupted");
      expect(status.textContent).toBe("Stopped");
      expect(status.innerHTML).not.toContain("danger");
    },
  );

  it("preserves a translated label without restoring destructive styling", () => {
    render(
      <ChatMessage
        appearance="panel"
        labels={{ responseInterrupted: "Detenida" }}
        message={interruptedMessage}
      />,
    );

    const status = screen.getByTestId("chat-message-interrupted");
    expect(status.textContent).toBe("Detenida");
    expect(status.innerHTML).not.toContain("danger");
  });
});
