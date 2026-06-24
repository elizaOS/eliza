// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessagesWidget } from "./messages";

afterEach(() => {
  cleanup();
});

// #9143 — the frontpage Messages widget renders recent conversations.
describe("MessagesWidget (#9143)", () => {
  it("renders its empty state when there are no conversations", () => {
    render(<MessagesWidget pluginId="messages" />);
    expect(screen.getByTestId("widget-messages")).toBeTruthy();
    expect(screen.getByText("No conversations yet")).toBeTruthy();
  });
});
