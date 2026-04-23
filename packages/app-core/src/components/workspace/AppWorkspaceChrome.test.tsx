// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppWorkspaceChrome } from "./AppWorkspaceChrome";

const { useMediaQueryMock } = vi.hoisted(() => ({
  useMediaQueryMock: vi.fn(),
}));

vi.mock("../../hooks", () => ({
  useMediaQuery: (query: string) => useMediaQueryMock(query),
}));

vi.mock("../pages/ChatView.js", () => ({
  ChatView: () => <div data-testid="default-chat" />,
}));

vi.mock("../pages/PageScopedChatPane.js", () => ({
  PageScopedChatPane: ({ scope }: { scope: string }) => (
    <div data-testid="page-scoped-chat">{scope}</div>
  ),
}));

describe("AppWorkspaceChrome", () => {
  beforeEach(() => {
    useMediaQueryMock.mockReset();
    useMediaQueryMock.mockReturnValue(false);
  });

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

  it("does not reserve right-chat width on mobile until the user opens it", () => {
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );

    render(
      <AppWorkspaceChrome
        testId="mobile-shell"
        main={<div data-testid="mobile-main">Mobile content</div>}
        chat={<div data-testid="mobile-chat">Chat content</div>}
      />,
    );

    const collapsedSidebar = screen.getByTestId("mobile-shell-chat-sidebar");
    expect(collapsedSidebar.getAttribute("data-collapsed")).not.toBeNull();
    expect(screen.getByTestId("mobile-main")).toBeTruthy();
    expect(screen.queryByTestId("mobile-chat")).toBeNull();
    expect(screen.queryByTestId("mobile-shell-chat-resize-handle")).toBeNull();

    fireEvent.click(screen.getByTestId("mobile-shell-chat-expand"));

    const openSidebar = screen.getByTestId("mobile-shell-chat-sidebar");
    expect(openSidebar.className).toContain("fixed");
    expect(openSidebar.getAttribute("style") ?? "").not.toContain("width");
    expect(screen.getByTestId("mobile-shell-chat-backdrop")).toBeTruthy();
    expect(screen.getByTestId("mobile-chat")).toBeTruthy();
  });
});
