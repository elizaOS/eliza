/** Verifies slash-prefixed chat text renders without command formatting. */
// @vitest-environment jsdom

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

  it.each(["/imagine a cat", "/settings"])(
    "renders %s as ordinary user text",
    (text) => {
      withApp(<MessageContent message={message("user", text)} />);
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByTestId("slash-command-token")).toBeNull();
    },
  );

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
    const { container } = withApp(
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
    expect(container.textContent ?? "").not.toContain("[form:submit");
    expect(container.textContent ?? "").not.toContain("Draft report");
    expect(container.textContent ?? "").not.toContain("2026-07-08T09:00");
  });
});
