// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatBubble } from "./chat-bubble";

afterEach(cleanup);

describe("ChatBubble glass hierarchy", () => {
  it("keeps user turns inside a quiet rounded bubble", () => {
    render(
      <ChatBubble tone="user" variant="glass">
        Authored message
      </ChatBubble>,
    );

    const bubble = screen.getByText("Authored message");
    expect(bubble.className).toContain("rounded-2xl");
    expect(bubble.className).toContain("rounded-br-md");
    expect(bubble.className).toContain("border-white/15");
    expect(bubble.className).toContain("bg-transparent");
  });

  it("keeps assistant turns as unboxed floating text", () => {
    render(
      <ChatBubble tone="assistant" variant="glass">
        Assistant reply
      </ChatBubble>,
    );

    const bubble = screen.getByText("Assistant reply");
    expect(bubble.className).not.toContain("border-white/15");
    expect(bubble.className).toContain("bg-transparent");
  });
});
