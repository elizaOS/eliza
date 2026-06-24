// @vitest-environment jsdom
//
// A reply containing a fenced code block renders it via the CodeBlock primitive
// with a per-block copy button that writes EXACTLY the block contents (#9148).
// Inline `code` spans render in the inline code primitive and stay in the flow
// of the sentence (no separate copy affordance).

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

vi.mock("../../api/client", () => ({ client: {} }));

import { MessageContent } from "./MessageContent";

function message(text: string): ConversationMessage {
  return {
    id: "m1",
    role: "assistant",
    text,
    timestamp: Date.now(),
  } as ConversationMessage;
}

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

describe("MessageContent code blocks", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
  });

  it("renders a fenced code block with a copy button that writes the exact block contents", async () => {
    const code = "const x = 1;\nconsole.log(x);";
    withApp(
      <MessageContent message={message(`Here:\n\`\`\`ts\n${code}\n\`\`\``)} />,
    );

    const block = screen.getByTestId("code-block");
    expect(block).toBeTruthy();
    // The rendered code text matches the block body exactly (fence + lang gone).
    expect(block.textContent).toContain("const x = 1;");
    expect(block.getAttribute("data-lang")).toBe("ts");

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(code);
  });

  it("renders inline code spans inline without a block copy affordance", () => {
    withApp(
      <MessageContent message={message("Run `npm install` to begin.")} />,
    );
    const inline = screen.getByTestId("inline-code");
    expect(inline.textContent).toBe("npm install");
    // No block-level code affordance for an inline-only message.
    expect(screen.queryByTestId("code-block")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});
