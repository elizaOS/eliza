// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppWorkspaceChrome } from "./AppWorkspaceChrome";

vi.mock("../pages/ChatView.js", () => ({
  ChatView: () => <div data-testid="default-chat" />,
}));

vi.mock("../pages/PageScopedChatPane.js", () => ({
  PageScopedChatPane: ({ scope }: { scope: string }) => (
    <div data-testid="page-scoped-chat">{scope}</div>
  ),
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

    const resizeHandle = screen.getByTestId("browser-shell-chat-resize-handle");
    expect(resizeHandle.tagName).toBe("HR");
    expect(resizeHandle.className).toContain("inset-y-0");
  });

  it("renders page-scoped chat when a chat scope is provided", () => {
    render(
      <AppWorkspaceChrome
        testId="apps-shell"
        chatScope="page-apps"
        main={<div data-testid="apps-main">Apps</div>}
      />,
    );

    expect(screen.queryByTestId("default-chat")).toBeNull();
    expect(screen.getByTestId("page-scoped-chat").textContent).toBe(
      "page-apps",
    );
  });
});
