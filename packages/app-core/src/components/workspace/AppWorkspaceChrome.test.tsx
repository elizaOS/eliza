// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppWorkspaceChrome } from "./AppWorkspaceChrome";

vi.mock("../pages/ChatView.js", () => ({
  ChatView: () => <div data-testid="default-chat" />,
}));

describe("AppWorkspaceChrome", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps page controls in the main pane beside the full-height chat sidebar", () => {
    render(
      <AppWorkspaceChrome
        testId="browser-shell"
        nav={<div data-testid="browser-controls">Browser controls</div>}
        main={<div data-testid="browser-main">Browser content</div>}
        chat={<div data-testid="browser-chat">Chat content</div>}
      />,
    );

    const root = screen.getByTestId("browser-shell");
    const leftPane = root.firstElementChild;
    const chatSidebar = screen.getByTestId("browser-shell-chat-sidebar");
    const browserControls = screen.getByTestId("browser-controls");
    const browserMain = screen.getByTestId("browser-main");

    expect(leftPane).not.toBeNull();
    expect(leftPane?.contains(browserControls)).toBe(true);
    expect(leftPane?.contains(browserMain)).toBe(true);
    expect(chatSidebar.parentElement).toBe(root);
    expect(chatSidebar.previousElementSibling).toBe(leftPane);
    expect(chatSidebar.contains(browserControls)).toBe(false);
  });
});
