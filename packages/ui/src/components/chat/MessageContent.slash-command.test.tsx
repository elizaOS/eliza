// @vitest-environment jsdom
//
// A user message that is a slash command renders the leading `/command` token
// in bold (so the transcript mirrors the composer's inline autocomplete);
// assistant text and plain user prose render without the bold token.

import { cleanup, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../api/client", () => ({ client: {} }));

import { MessageContent } from "./MessageContent";

function message(
  role: "user" | "assistant",
  text: string,
): ConversationMessage {
  return { id: "m1", role, text, timestamp: Date.now() } as ConversationMessage;
}

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  // MessageContent reads context via the selector store, so seed it too.
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

describe("MessageContent slash-command bolding", () => {
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("renders the leading slash token in bold for a user command", () => {
    withApp(<MessageContent message={message("user", "/imagine a cat")} />);
    const token = screen.getByTestId("slash-command-token");
    expect(token.textContent).toBe("/imagine");
    expect(token.className).toContain("font-bold");
    // The argument remainder stays in the surrounding (non-bold) text.
    expect(screen.getByText(/a cat/)).toBeTruthy();
  });

  it("bolds a bare command with no arguments", () => {
    withApp(<MessageContent message={message("user", "/settings")} />);
    expect(screen.getByTestId("slash-command-token").textContent).toBe(
      "/settings",
    );
  });

  it("does not bold a leading slash in assistant text", () => {
    withApp(
      <MessageContent message={message("assistant", "/imagine a cat")} />,
    );
    expect(screen.queryByTestId("slash-command-token")).toBeNull();
  });

  it("does not bold plain user prose", () => {
    withApp(<MessageContent message={message("user", "just a message")} />);
    expect(screen.queryByTestId("slash-command-token")).toBeNull();
  });

  it("renders a submitted form as a compact receipt instead of raw marker JSON", () => {
    withApp(
      <MessageContent
        message={message(
          "user",
          '[form:submit reminder-details] {"title":"Draft report","when":"2026-07-08T09:00"}',
        )}
      />,
    );

    expect(screen.getByTestId("form-submit-receipt").textContent).toBe(
      "Submitted reminder details",
    );
    expect(screen.queryByText(/\[form:submit/)).toBeNull();
    expect(screen.queryByText(/Draft report/)).toBeNull();
  });
});
