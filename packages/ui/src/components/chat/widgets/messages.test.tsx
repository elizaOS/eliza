// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessagesWidget } from "./messages";

afterEach(() => {
  cleanup();
});

// #9143 — the frontpage Messages widget renders recent conversations.
// #9226 — when there are no conversations it renders nothing (no empty
// placeholder card) so the Springboard home isn't cluttered with dead slots.
describe("MessagesWidget (#9143)", () => {
  it("renders nothing when there are no conversations (#9226)", () => {
    const { container } = render(<MessagesWidget pluginId="messages" />);
    expect(screen.queryByTestId("widget-messages")).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
