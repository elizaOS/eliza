// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppWorkspaceChrome,
  useAppWorkspaceChatChrome,
} from "./AppWorkspaceChrome";

var useMediaQueryMock = vi.fn();

vi.mock("../../hooks", () => ({
  useMediaQuery: (query: string) => useMediaQueryMock(query),
}));

vi.mock("../pages/ChatView.js", () => ({
  ChatView: () => <div data-testid="default-chat" />,
}));

vi.mock("../pages/PageScopedChatPane.js", () => ({
  PageScopedChatPane: ({
    footerActions,
    scope,
  }: {
    footerActions?: ReactNode;
    scope: string;
  }) => (
    <div data-testid="page-scoped-chat">
      <span>{scope}</span>
      {footerActions ? (
        <div data-testid="page-scoped-chat-footer-actions">
          {footerActions}
        </div>
      ) : null}
    </div>
  ),
}));

describe("AppWorkspaceChrome", () => {
  beforeEach(() => {
    useMediaQueryMock.mockReset();
    useMediaQueryMock.mockReturnValue(false);
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
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
    expect(
      screen.queryByTestId("page-scoped-chat-footer-actions"),
    ).toBeNull();
    const collapseButton = screen.getByTestId("apps-shell-chat-collapse");
    expect(collapseButton.className).toContain("bottom-2");
    expect(collapseButton.className).toContain("right-2");
    expect(collapseButton.className).toContain("h-6");
    expect(collapseButton.className).toContain("w-6");
    expect(collapseButton.className).toContain("bg-transparent");
    expect(collapseButton.className).not.toContain("bg-card/85");
    expect(collapseButton.className).not.toContain("shadow-md");
    expect(collapseButton.className).not.toContain("border-border/40");

    fireEvent.click(collapseButton);

    const collapsedSidebar = screen.getByTestId("apps-shell-chat-sidebar");
    expect(collapsedSidebar.getAttribute("data-collapsed")).not.toBeNull();
    const expandButton = screen.getByTestId("apps-shell-chat-expand");
    expect(expandButton.className).toContain("bottom-2");
    expect(expandButton.className).toContain("right-2");
    expect(expandButton.className).toContain("h-6");
    expect(expandButton.className).toContain("w-6");
    expect(expandButton.className).toContain("bg-transparent");
    expect(expandButton.className).not.toContain("bg-card/85");
    expect(expandButton.className).not.toContain("shadow-md");
    expect(expandButton.className).not.toContain("border-border/40");
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

  it("lets main-pane content open chat through the workspace chrome context", () => {
    useMediaQueryMock.mockImplementation(
      (query: string) => query === "(max-width: 639px)",
    );

    function OpenChatFromMain() {
      const chatChrome = useAppWorkspaceChatChrome();

      return (
        <button
          type="button"
          data-testid="main-open-chat"
          onClick={() => chatChrome?.openChat()}
        >
          Open chat
        </button>
      );
    }

    render(
      <AppWorkspaceChrome
        testId="main-chat-shell"
        main={<OpenChatFromMain />}
        chat={<div data-testid="main-chat">Chat content</div>}
      />,
    );

    expect(screen.queryByTestId("main-chat")).toBeNull();

    fireEvent.click(screen.getByTestId("main-open-chat"));

    expect(screen.getByTestId("main-chat")).toBeTruthy();
    expect(screen.getByTestId("main-chat-shell-chat-backdrop")).toBeTruthy();
  });

  it("lets chat content own the collapse control row", () => {
    function InlineCollapseOwner() {
      const chatChrome = useAppWorkspaceChatChrome();

      return (
        <button
          type="button"
          data-testid="inline-chat-collapse"
          onClick={() => chatChrome?.collapseChat()}
        >
          Collapse inline
        </button>
      );
    }

    render(
      <AppWorkspaceChrome
        testId="owned-footer-shell"
        hideCollapseButton
        main={<div data-testid="owned-footer-main">Owned footer content</div>}
        chat={<InlineCollapseOwner />}
      />,
    );

    expect(screen.queryByTestId("owned-footer-shell-chat-collapse")).toBeNull();

    fireEvent.click(screen.getByTestId("inline-chat-collapse"));

    const collapsedSidebar = screen.getByTestId(
      "owned-footer-shell-chat-sidebar",
    );
    expect(collapsedSidebar.getAttribute("data-collapsed")).not.toBeNull();
    expect(screen.getByTestId("owned-footer-shell-chat-expand")).toBeTruthy();
  });
});
